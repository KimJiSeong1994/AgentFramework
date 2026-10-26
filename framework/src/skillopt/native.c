#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <time.h>

#if defined(__APPLE__) && defined(__MACH__)
#include <sys/mount.h>
#include <sys/sysctl.h>
#include <mach/kern_return.h>
#include <mach/mach_time.h>
#define NATIVE_PLATFORM "darwin"
#define STAT_MTIME(st) ((st)->st_mtimespec)
#define STAT_CTIME(st) ((st)->st_ctimespec)
#ifndef F_FULLFSYNC
#error "F_FULLFSYNC is required; Darwin helper must not build without it"
#endif
#ifndef RENAME_SWAP
#define RENAME_SWAP 0x00000002
#endif
#elif defined(__linux__)
#include <sys/vfs.h>
#include <sys/syscall.h>
#include <sys/random.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#define NATIVE_PLATFORM "linux"
#define STAT_MTIME(st) ((st)->st_mtim)
#define STAT_CTIME(st) ((st)->st_ctim)
#ifndef EXT4_SUPER_MAGIC
#define EXT4_SUPER_MAGIC 0xEF53
#endif
#else
#error "skillopt native helper supports only Darwin and Linux"
#endif

#define MAX_SKILL_BYTES 16384
#define PROTOCOL "skillopt-promotion.v3"
#define LINUX_RENAME_EXCHANGE (1U << 1)
#define CLOCK_ID_MAX 36

#if defined(__linux__)
/* ext2/ext3/ext4 share a statfs magic. Only the pinned descriptor's actual ext4 mount qualifies. */
static int mount_line_ext4(const char *line, uint64_t mount_id) {
  if (line[0] < '0' || line[0] > '9') return 0;
  char *end;
  errno = 0;
  unsigned long long parsed = strtoull(line, &end, 10);
  if (errno || *end != ' ' || (uint64_t)parsed != mount_id) return 0;
  const char *separator = strstr(end, " - ");
  return separator && strncmp(separator + 3, "ext4 ", 5) == 0 ? 1 : -1;
}
#endif

static int supported_filesystem(int fd) {
#if defined(__APPLE__) && defined(__MACH__)
  struct statfs filesystem;
  return !fstatfs(fd, &filesystem) && strcmp(filesystem.f_fstypename, "apfs") == 0;
#elif defined(__linux__)
  struct statfs filesystem;
  struct statx before, after;
  if (fstatfs(fd, &filesystem) || (unsigned long)filesystem.f_type != (unsigned long)EXT4_SUPER_MAGIC ||
      statx(fd, "", AT_EMPTY_PATH, STATX_MNT_ID, &before) || !(before.stx_mask & STATX_MNT_ID)) return 0;
  FILE *mounts = fopen("/proc/self/mountinfo", "re");
  if (!mounts) return 0;
  char line[8192];
  size_t bytes = 0;
  int matches = 0, valid = 1;
  while (fgets(line, sizeof(line), mounts)) {
    bytes += strlen(line);
    if (bytes > 1024 * 1024 || !strchr(line, '\n')) { valid = 0; break; }
    int match = mount_line_ext4(line, before.stx_mnt_id);
    if (match) {
      matches++;
      if (match < 0 || matches > 1) valid = 0;
    }
  }
  if (ferror(mounts)) valid = 0;
  if (fclose(mounts)) valid = 0;
  if (statx(fd, "", AT_EMPTY_PATH, STATX_MNT_ID, &after) || !(after.stx_mask & STATX_MNT_ID) ||
      before.stx_mnt_id != after.stx_mnt_id) valid = 0;
  return valid && matches == 1;
#endif
}

static int open_directory_component(int parent, const char *name) {
  int flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
#if defined(__linux__) && defined(SYS_openat2)
  struct open_how how = {
    .flags = (uint64_t)flags,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  int fd = (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
  if (fd >= 0 || errno != ENOSYS) return fd;
#endif
  /* Older kernels still get the same component-wise nofollow + fstat identity checks below. */
  return openat(parent, name, flags);
}

static int stat_time_ns(const struct timespec *time, int64_t *value) {
  if (time->tv_nsec < 0 || time->tv_nsec >= 1000000000L) return -1;
  __int128 nanoseconds = (__int128)time->tv_sec * 1000000000 + time->tv_nsec;
  if (nanoseconds < INT64_MIN || nanoseconds > INT64_MAX) return -1;
  *value = (int64_t)nanoseconds;
  return 0;
}

static int clock_value_ns(const struct timespec *time, uint64_t *value) {
  if (time->tv_sec < 0 || time->tv_nsec < 0 || time->tv_nsec >= 1000000000L ||
      (uint64_t)time->tv_sec > (UINT64_MAX - (uint64_t)time->tv_nsec) / 1000000000ULL) return -1;
  *value = (uint64_t)time->tv_sec * 1000000000ULL + (uint64_t)time->tv_nsec;
  return 0;
}

static int valid_boot_id(const char *text, size_t length) {
  if (length != CLOCK_ID_MAX) return 0;
  for (size_t i = 0; i < length; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (text[i] != '-') return 0;
    } else if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f') ||
                 (text[i] >= 'A' && text[i] <= 'F'))) return 0;
  }
  return 1;
}

static int native_clock(char boot_id[CLOCK_ID_MAX + 1], uint64_t *continuous_ns, uint64_t *wall_ms) {
#if defined(__APPLE__) && defined(__MACH__)
  size_t boot_length = CLOCK_ID_MAX + 1;
  if (sysctlbyname("kern.bootsessionuuid", boot_id, &boot_length, NULL, 0) || boot_length == 0) return -1;
  size_t id_length = strnlen(boot_id, boot_length);
  if (id_length > 0 && boot_id[id_length - 1] == '\0') id_length--;
  if (!valid_boot_id(boot_id, id_length)) return -1;
  boot_id[id_length] = '\0';

  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return -1;
  __uint128_t converted = (__uint128_t)mach_continuous_time() * timebase.numer / timebase.denom;
  if (converted == 0 || converted > UINT64_MAX) return -1;
  *continuous_ns = (uint64_t)converted;
#elif defined(__linux__)
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  char bytes[CLOCK_ID_MAX + 2];
  ssize_t count;
  do { count = read(fd, bytes, sizeof(bytes)); } while (count < 0 && errno == EINTR);
  int close_result = close(fd);
  if (count != CLOCK_ID_MAX + 1 || close_result || bytes[CLOCK_ID_MAX] != '\n' ||
      !valid_boot_id(bytes, CLOCK_ID_MAX)) return -1;
  memcpy(boot_id, bytes, CLOCK_ID_MAX);
  boot_id[CLOCK_ID_MAX] = '\0';
  struct timespec continuous;
  if (clock_gettime(CLOCK_BOOTTIME, &continuous) || clock_value_ns(&continuous, continuous_ns) || *continuous_ns == 0) return -1;
#endif
  struct timespec wall;
  uint64_t wall_ns;
  if (clock_gettime(CLOCK_REALTIME, &wall) || clock_value_ns(&wall, &wall_ns) || wall_ns == 0) return -1;
  *wall_ms = wall_ns / 1000000ULL;
  return *wall_ms == 0 ? -1 : 0;
}

static int fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  return 1;
}

static int parse_u64(const char *text, uint64_t *value) {
  char *end = NULL;
  if (!text[0] || strspn(text, "0123456789") != strlen(text)) return -1;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno || !end || *end) return -1;
  *value = (uint64_t)parsed;
  return 0;
}

static int valid_name(const char *name) {
  size_t length = strlen(name);
  return length > 0 && length < NAME_MAX && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 &&
    strchr(name, '/') == NULL && strchr(name, '\\') == NULL;
}

static int open_directory(const char *path, const char *dev_text, const char *ino_text, struct stat *result) {
  char canonical[PATH_MAX];
  uint64_t expected_dev, expected_ino;
  errno = 0;
  if (!path || path[0] != '/' || strlen(path) >= sizeof(canonical) ||
      parse_u64(dev_text, &expected_dev) || parse_u64(ino_text, &expected_ino)) return -1;
  if (!realpath(path, canonical)) return -1;
  if (strcmp(path, canonical) != 0) { errno = ELOOP; return -1; }

  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  const char *component = path + 1;
  while (*component) {
    const char *slash = strchr(component, '/');
    size_t length = slash ? (size_t)(slash - component) : strlen(component);
    if (length == 0 || length >= NAME_MAX) { close(fd); errno = EINVAL; return -1; }
    char name[NAME_MAX];
    memcpy(name, component, length);
    name[length] = '\0';
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) { close(fd); errno = EINVAL; return -1; }
    int next = open_directory_component(fd, name);
    if (next < 0) { close(fd); return -1; }
    struct stat component_stat;
    if (fstat(next, &component_stat) || !S_ISDIR(component_stat.st_mode)) {
      close(next); close(fd); return -1;
    }
    close(fd);
    fd = next;
    if (!slash) break;
    component = slash + 1;
  }

  if (fstat(fd, result) || !S_ISDIR(result->st_mode) || (uint64_t)result->st_dev != expected_dev ||
      (uint64_t)result->st_ino != expected_ino || result->st_uid != getuid()) {
    close(fd);
    return -1;
  }
  if (!supported_filesystem(fd)) {
    close(fd);
    errno = ENOTSUP;
    return -1;
  }
  return fd;
}

static int fail_directory(const char *fallback) {
  return fail(errno == ENOTSUP ? "unsupported-filesystem" : fallback);
}

static int exchange_names(int dirfd, const char *left, const char *right) {
#if defined(__APPLE__) && defined(__MACH__)
  return renameatx_np(dirfd, left, dirfd, right, RENAME_SWAP);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, dirfd, left, dirfd, right, LINUX_RENAME_EXCHANGE);
#else
  (void)dirfd; (void)left; (void)right;
  errno = ENOSYS;
  return -1;
#endif
}

static int random_bytes(void *buffer, size_t length) {
#if defined(__APPLE__) && defined(__MACH__)
  arc4random_buf(buffer, length);
  return 0;
#elif defined(__linux__)
  unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = getrandom(bytes + offset, length - offset, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
#endif
}

static int same_stat(const struct stat *left, const struct stat *right) {
  const struct timespec left_mtime = STAT_MTIME(left), right_mtime = STAT_MTIME(right);
  const struct timespec left_ctime = STAT_CTIME(left), right_ctime = STAT_CTIME(right);
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino && left->st_mode == right->st_mode &&
    left->st_nlink == right->st_nlink && left->st_uid == right->st_uid && left->st_size == right->st_size &&
    left_mtime.tv_sec == right_mtime.tv_sec && left_mtime.tv_nsec == right_mtime.tv_nsec &&
    left_ctime.tv_sec == right_ctime.tv_sec && left_ctime.tv_nsec == right_ctime.tv_nsec;
}

static int open_regular_at(int dirfd, const struct stat *directory, const char *name, struct stat *result) {
  if (!valid_name(name)) return -1;
  struct stat by_name;
  if (fstatat(dirfd, name, &by_name, AT_SYMLINK_NOFOLLOW) || !S_ISREG(by_name.st_mode) || by_name.st_nlink != 1 ||
      by_name.st_uid != getuid() || by_name.st_dev != directory->st_dev || (by_name.st_mode & (S_ISUID | S_ISGID | S_ISVTX))) return -1;
  int fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return -1;
  if (fstat(fd, result) || !same_stat(&by_name, result)) {
    close(fd);
    return -1;
  }
  return fd;
}

static int flush_fd(int fd) {
  if (fsync(fd)) return -1;
#if defined(__APPLE__) && defined(__MACH__)
  if (fcntl(fd, F_FULLFSYNC) == -1) return -1;
#endif
  return 0;
}

static int print_base64(const unsigned char *data, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (size_t i = 0; i < length; i += 3) {
    uint32_t a = data[i];
    uint32_t b = i + 1 < length ? data[i + 1] : 0;
    uint32_t c = i + 2 < length ? data[i + 2] : 0;
    char out[4] = {
      alphabet[(a >> 2) & 63], alphabet[((a << 4) | (b >> 4)) & 63],
      i + 1 < length ? alphabet[((b << 2) | (c >> 6)) & 63] : '=',
      i + 2 < length ? alphabet[c & 63] : '=',
    };
    if (fwrite(out, 1, sizeof(out), stdout) != sizeof(out)) return -1;
  }
  return 0;
}

static int inspect_file(const char *directory, const char *dev, const char *ino, const char *name) {
  struct stat dir_stat, before, after;
  int64_t mtime_ns, ctime_ns;
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail_directory("unsafe-directory");
  int fd = open_regular_at(dirfd, &dir_stat, name, &before);
  if (fd < 0 || before.st_size < 0 || before.st_size > MAX_SKILL_BYTES) {
    if (fd >= 0) close(fd);
    close(dirfd);
    return fail("unsafe-file");
  }
  unsigned char bytes[MAX_SKILL_BYTES];
  size_t offset = 0;
  while (offset < (size_t)before.st_size) {
    ssize_t count = pread(fd, bytes + offset, (size_t)before.st_size - offset, (off_t)offset);
    if (count <= 0) { close(fd); close(dirfd); return fail("read-failed"); }
    offset += (size_t)count;
  }
  struct stat dir_after, named_after;
  if (fstat(fd, &after) || !same_stat(&before, &after) || fstat(dirfd, &dir_after) ||
      fstatat(dirfd, name, &named_after, AT_SYMLINK_NOFOLLOW) || !same_stat(&after, &named_after) ||
      dir_after.st_dev != dir_stat.st_dev || dir_after.st_ino != dir_stat.st_ino) {
    close(fd); close(dirfd); return fail("file-changed-during-inspect");
  }
  if (stat_time_ns(&STAT_MTIME(&after), &mtime_ns) || stat_time_ns(&STAT_CTIME(&after), &ctime_ns)) {
    close(fd); close(dirfd); return fail("unsafe-stat-time");
  }
  if (printf("{\"dev\":\"%" PRIu64 "\",\"ino\":\"%" PRIu64 "\",\"uid\":%u,\"mode\":%u,\"nlink\":%u,\"size\":%" PRIu64 ",\"mtimeNs\":\"%" PRId64 "\",\"ctimeNs\":\"%" PRId64 "\",\"base64\":\"",
      (uint64_t)after.st_dev, (uint64_t)after.st_ino, (unsigned int)after.st_uid, (unsigned int)after.st_mode,
      (unsigned int)after.st_nlink, (uint64_t)after.st_size,
      mtime_ns, ctime_ns) < 0 ||
      print_base64(bytes, (size_t)before.st_size) || printf("\"}\n") < 0) {
    close(fd); close(dirfd); return fail("write-output-failed");
  }
  close(fd);
  close(dirfd);
  return 0;
}

static int sync_directory(const char *directory, const char *dev, const char *ino) {
  struct stat directory_stat, after;
  int fd = open_directory(directory, dev, ino, &directory_stat);
  if (fd < 0) return fail_directory("unsafe-directory");
  int result = fsync(fd);
  if (!result && (fstat(fd, &after) || after.st_dev != directory_stat.st_dev || after.st_ino != directory_stat.st_ino)) result = -1;
  close(fd);
  return result ? fail("directory-fsync-failed") : 0;
}

static int flush_file(const char *directory, const char *dev, const char *ino, const char *name,
    const char *file_dev_text, const char *file_ino_text) {
  uint64_t expected_dev, expected_ino;
  struct stat dir_stat, before, after;
  if (parse_u64(file_dev_text, &expected_dev) || parse_u64(file_ino_text, &expected_ino)) return fail("invalid-file-identity");
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail_directory("unsafe-directory");
  int fd = open_regular_at(dirfd, &dir_stat, name, &before);
  if (fd < 0 || (uint64_t)before.st_dev != expected_dev || (uint64_t)before.st_ino != expected_ino) {
    if (fd >= 0) close(fd);
    close(dirfd);
    return fail("file-identity-mismatch");
  }
  int result = flush_fd(fd);
  if (!result && (fstat(fd, &after) || !same_stat(&before, &after))) result = -1;
  close(fd);
  close(dirfd);
  return result ? fail("file-fullsync-failed") : 0;
}

static int unlink_probe_if_same(int dirfd, const char *name, const struct stat *expected) {
  struct stat named;
  if (fstatat(dirfd, name, &named, AT_SYMLINK_NOFOLLOW)) return errno == ENOENT ? 0 : -1;
  if (!S_ISREG(named.st_mode) || named.st_dev != expected->st_dev || named.st_ino != expected->st_ino) return -1;
  return unlinkat(dirfd, name, 0);
}

static int write_probe_marker(int fd, unsigned char marker) {
  ssize_t count;
  do { count = write(fd, &marker, 1); } while (count < 0 && errno == EINTR);
  return count == 1 ? 0 : -1;
}

static int probe_directory(const char *directory, const char *dev, const char *ino) {
  struct stat dir_stat, first_stat, second_stat, after_first, after_second, after;
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail_directory("unsafe-directory");
  if (fsync(dirfd)) { close(dirfd); return fail("directory-fsync-unsupported"); }
  char first_name[NAME_MAX], second_name[NAME_MAX];
  unsigned char random[12];
  if (random_bytes(random, sizeof(random))) { close(dirfd); return fail("probe-random-failed"); }
  int first_length = snprintf(first_name, sizeof(first_name), ".skillopt-probe-%ld-%02x%02x%02x%02x-a",
    (long)getpid(), (unsigned)random[0], (unsigned)random[1], (unsigned)random[2], (unsigned)random[3]);
  int second_length = snprintf(second_name, sizeof(second_name), ".skillopt-probe-%ld-%02x%02x%02x%02x-b",
    (long)getpid(), (unsigned)random[0], (unsigned)random[1], (unsigned)random[2], (unsigned)random[3]);
  if (first_length <= 0 || first_length >= (int)sizeof(first_name) || second_length <= 0 || second_length >= (int)sizeof(second_name)) {
    close(dirfd); return fail("probe-name-invalid");
  }

  int first_fd = -1, second_fd = -1, first_read_fd = -1, second_read_fd = -1;
  int result = -1, swapped = 0, first_created = 0, second_created = 0;
  const unsigned char first_marker = 0x35, second_marker = 0x6a;
  first_fd = openat(dirfd, first_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (first_fd < 0 || fstat(first_fd, &first_stat)) goto cleanup;
  first_created = 1;
  if (!S_ISREG(first_stat.st_mode) || first_stat.st_nlink != 1 || first_stat.st_uid != getuid() ||
      first_stat.st_dev != dir_stat.st_dev || (first_stat.st_mode & 0777) != 0600) goto cleanup;
  second_fd = openat(dirfd, second_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (second_fd < 0 || fstat(second_fd, &second_stat)) goto cleanup;
  second_created = 1;
  if (!S_ISREG(second_stat.st_mode) || second_stat.st_nlink != 1 || second_stat.st_uid != getuid() ||
      second_stat.st_dev != dir_stat.st_dev || (second_stat.st_mode & 0777) != 0600) goto cleanup;
  if (write_probe_marker(first_fd, first_marker) || write_probe_marker(second_fd, second_marker) ||
      flush_fd(first_fd) || flush_fd(second_fd) || fstat(first_fd, &first_stat) || fstat(second_fd, &second_stat)) goto cleanup;
  if (close(first_fd)) { first_fd = -1; goto cleanup; }
  first_fd = -1;
  if (close(second_fd)) { second_fd = -1; goto cleanup; }
  second_fd = -1;
  if (fsync(dirfd)) goto cleanup;
  first_read_fd = open_regular_at(dirfd, &dir_stat, first_name, &after_first);
  second_read_fd = open_regular_at(dirfd, &dir_stat, second_name, &after_second);
  if (first_read_fd < 0 || second_read_fd < 0 || !same_stat(&first_stat, &after_first) || !same_stat(&second_stat, &after_second)) goto cleanup;
  if (exchange_names(dirfd, second_name, first_name)) goto cleanup;
  swapped = 1;
  if (fsync(dirfd)) goto cleanup;
  int first_post_fd = open_regular_at(dirfd, &dir_stat, first_name, &after_first);
  int second_post_fd = open_regular_at(dirfd, &dir_stat, second_name, &after_second);
  unsigned char first_byte = 0, second_byte = 0;
  if (first_post_fd < 0 || second_post_fd < 0 || after_first.st_dev != second_stat.st_dev || after_first.st_ino != second_stat.st_ino ||
      after_second.st_dev != first_stat.st_dev || after_second.st_ino != first_stat.st_ino ||
      pread(first_post_fd, &first_byte, 1, 0) != 1 || pread(second_post_fd, &second_byte, 1, 0) != 1 ||
      first_byte != second_marker || second_byte != first_marker || flush_fd(first_post_fd) || flush_fd(second_post_fd)) {
    if (first_post_fd >= 0) close(first_post_fd);
    if (second_post_fd >= 0) close(second_post_fd);
    goto cleanup;
  }
  close(first_post_fd);
  close(second_post_fd);
  if (fsync(dirfd)) goto cleanup;
  result = 0;

cleanup:
  if (first_fd >= 0 && close(first_fd)) result = -1;
  if (second_fd >= 0 && close(second_fd)) result = -1;
  if (first_read_fd >= 0) close(first_read_fd);
  if (second_read_fd >= 0) close(second_read_fd);
  if (first_created && unlink_probe_if_same(dirfd, first_name, swapped ? &second_stat : &first_stat)) result = -1;
  if (second_created && unlink_probe_if_same(dirfd, second_name, swapped ? &first_stat : &second_stat)) result = -1;
  if (fsync(dirfd)) result = -1;
  if (fstat(dirfd, &after) || after.st_dev != dir_stat.st_dev || after.st_ino != dir_stat.st_ino) result = -1;
  close(dirfd);
  return result ? fail("durability-probe-failed") : 0;
}

static void exchange_test_boundary(const char *name) {
#ifdef SKILLOPT_TEST_FAULTS
  const char *root = getenv("SKILLOPT_TEST_BARRIERS");
  if (!root) return;
  char ready[PATH_MAX], release[PATH_MAX];
  if (snprintf(ready, sizeof(ready), "%s/%s.ready", root, name) >= (int)sizeof(ready) ||
      snprintf(release, sizeof(release), "%s/%s.release", root, name) >= (int)sizeof(release)) _exit(87);
  int fd = open(ready, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) _exit(87);
  close(fd);
  for (int i = 0; access(release, F_OK); i++) {
    if (i == 10000) _exit(87);
    usleep(1000);
  }
#else
  (void)name;
#endif
}

static int print_snapshot(const struct stat *st) {
  if (!st) return printf("null") < 0 ? -1 : 0;
  int64_t mtime_ns, ctime_ns;
  if (stat_time_ns(&STAT_MTIME(st), &mtime_ns) || stat_time_ns(&STAT_CTIME(st), &ctime_ns)) return -1;
  return printf("{\"dev\":\"%" PRIu64 "\",\"ino\":\"%" PRIu64 "\",\"uid\":%u,\"mode\":%u,\"nlink\":%u,\"size\":%" PRIu64
    ",\"mtimeNs\":\"%" PRId64 "\",\"ctimeNs\":\"%" PRId64 "\"}",
    (uint64_t)st->st_dev, (uint64_t)st->st_ino, (unsigned)st->st_uid, (unsigned)st->st_mode,
    (unsigned)st->st_nlink, (uint64_t)st->st_size, mtime_ns, ctime_ns) < 0 ? -1 : 0;
}

static int capture_displaced(int source, int retention, const char *name, struct stat *captured) {
  struct stat before, after, named;
  if (fstat(source, &before) || !S_ISREG(before.st_mode) || before.st_size < 0 ||
      before.st_size > MAX_SKILL_BYTES) return -1;
  unsigned char bytes[MAX_SKILL_BYTES];
  size_t length = (size_t)before.st_size, offset = 0;
  while (offset < length) {
    ssize_t count = pread(source, bytes + offset, length - offset, (off_t)offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  if (fstat(source, &after) || !same_stat(&before, &after)) return -1;
  int fd = openat(retention, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int result = 0;
  offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count <= 0) { result = -1; break; }
    offset += (size_t)count;
  }
  if (flush_fd(fd) || fsync(retention) || fstat(fd, captured) ||
      fstatat(retention, name, &named, AT_SYMLINK_NOFOLLOW) || !same_stat(captured, &named) ||
      fstat(source, &after) || !same_stat(&before, &after)) result = -1;
  /* A second read binds content as well as metadata while the source FD is alive. */
  unsigned char check[MAX_SKILL_BYTES];
  offset = 0;
  while (!result && offset < length) {
    ssize_t count = pread(source, check + offset, length - offset, (off_t)offset);
    if (count <= 0) { result = -1; break; }
    offset += (size_t)count;
  }
  if (!result && (memcmp(bytes, check, length) || fstat(source, &after) || !same_stat(&before, &after))) result = -1;
  close(fd);
  return result;
}

static void wait_for_recovery_ack(void) {
  char input[9];
  if (fgets(input, sizeof(input), stdin) && strcmp(input, "RELEASE\n") == 0) return;
  /* EOF or an invalid acknowledgement cannot release an uncaptured observed inode. */
  for (;;) pause();
}

static int exchange_files(const char *directory, const char *dev, const char *ino,
    const char *target, const char *target_dev_text, const char *target_ino_text,
    const char *stage, const char *stage_dev_text, const char *stage_ino_text,
    const char *retention_path, const char *retention_dev, const char *retention_ino, const char *capture_name) {
  uint64_t target_dev, target_ino, stage_dev, stage_ino;
  struct stat dir_stat, target_before, stage_before, target_after, stage_after, retention_stat, captured;
  if (parse_u64(target_dev_text, &target_dev) || parse_u64(target_ino_text, &target_ino) ||
      parse_u64(stage_dev_text, &stage_dev) || parse_u64(stage_ino_text, &stage_ino) ||
      !valid_name(target) || !valid_name(stage) || strcmp(target, stage) == 0 ||
      !valid_name(capture_name) ||
      strspn(capture_name, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") != strlen(capture_name))
    return fail("invalid-exchange-arguments");
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail_directory("unsafe-directory");
  int retention = open_directory(retention_path, retention_dev, retention_ino, &retention_stat);
  if (retention < 0 || (retention_stat.st_mode & 0777) != 0700) {
    if (retention >= 0) close(retention);
    close(dirfd);
    return retention < 0 ? fail_directory("unsafe-retention-directory") : fail("unsafe-retention-directory");
  }
  int target_fd = open_regular_at(dirfd, &dir_stat, target, &target_before);
  int stage_fd = open_regular_at(dirfd, &dir_stat, stage, &stage_before);
  if (target_fd < 0 || stage_fd < 0 || (uint64_t)target_before.st_dev != target_dev || (uint64_t)target_before.st_ino != target_ino ||
      (uint64_t)stage_before.st_dev != stage_dev || (uint64_t)stage_before.st_ino != stage_ino ||
      target_before.st_dev != stage_before.st_dev || target_before.st_ino == stage_before.st_ino) {
    if (target_fd >= 0) close(target_fd);
    if (stage_fd >= 0) close(stage_fd);
    close(retention); close(dirfd);
    return fail("exchange-precondition-failed");
  }
  int64_t ignored_ns;
  if (stat_time_ns(&STAT_MTIME(&target_before), &ignored_ns) || stat_time_ns(&STAT_CTIME(&target_before), &ignored_ns) ||
      stat_time_ns(&STAT_MTIME(&stage_before), &ignored_ns) || stat_time_ns(&STAT_CTIME(&stage_before), &ignored_ns)) {
    close(target_fd); close(stage_fd); close(retention); close(dirfd);
    return fail("unsafe-stat-time");
  }
  exchange_test_boundary("before-swap");
  if (exchange_names(dirfd, stage, target)) {
    close(target_fd); close(stage_fd); close(retention); close(dirfd);
    return fail("atomic-exchange-failed");
  }
  int result = fsync(dirfd);
  int post_target_fd = -1;
  int post_stage_fd = -1;
  post_target_fd = open_regular_at(dirfd, &dir_stat, target, &target_after);
  post_stage_fd = open_regular_at(dirfd, &dir_stat, stage, &stage_after);
  exchange_test_boundary("post-open");
  int unexpected_stage = post_stage_fd >= 0 &&
    (stage_after.st_dev != target_before.st_dev || stage_after.st_ino != target_before.st_ino);
  int capture_ok = unexpected_stage && capture_displaced(post_stage_fd, retention, capture_name, &captured) == 0;
  if (post_target_fd >= 0 && flush_fd(post_target_fd)) result = -1;
  if (post_stage_fd >= 0 && flush_fd(post_stage_fd)) result = -1;
  if (fsync(dirfd)) result = -1;
  struct stat named_target, named_stage;
  int target_named = post_target_fd >= 0 && !fstat(post_target_fd, &target_after) &&
    !fstatat(dirfd, target, &named_target, AT_SYMLINK_NOFOLLOW) && same_stat(&target_after, &named_target);
  int stage_named = post_stage_fd >= 0 && !fstat(post_stage_fd, &stage_after) &&
    !fstatat(dirfd, stage, &named_stage, AT_SYMLINK_NOFOLLOW) && same_stat(&stage_after, &named_stage);
  int snapshots_valid = post_target_fd >= 0 && !stat_time_ns(&STAT_MTIME(&target_after), &ignored_ns) &&
    !stat_time_ns(&STAT_CTIME(&target_after), &ignored_ns) &&
    (post_stage_fd < 0 || (!stat_time_ns(&STAT_MTIME(&stage_after), &ignored_ns) &&
      !stat_time_ns(&STAT_CTIME(&stage_after), &ignored_ns)));
  const char *status = "EXCHANGED", *reason = NULL;
  if (!snapshots_valid || !target_named || (!stage_named && !capture_ok)) { status = "RACE_HELD"; reason = "post-swap-inspection-failed"; }
  else if (unexpected_stage && !capture_ok) { status = "RACE_HELD"; reason = "capture-unavailable"; }
  else if (result || target_after.st_dev != stage_before.st_dev || target_after.st_ino != stage_before.st_ino) {
    status = "RACE_HELD"; reason = "exchange-durability-failed";
  } else if (capture_ok) { status = "RACE_CAPTURED"; reason = "unexpected-displaced-inode"; }
  printf("{\"protocol\":\"%s\",\"platform\":\"%s\",\"status\":\"%s\",\"exchangeOccurred\":true,\"reason\":",
    PROTOCOL, NATIVE_PLATFORM, status);
  if (reason) printf("\"%s\"", reason); else printf("null");
  printf(",\"target\":");
  if (print_snapshot(post_target_fd >= 0 ? &target_after : NULL)) printf("null");
  printf(",\"stage\":");
  if (print_snapshot(post_stage_fd >= 0 ? &stage_after : NULL)) printf("null");
  printf(",\"capture\":");
  if (capture_ok) printf("{\"name\":\"%s\",\"dev\":\"%" PRIu64 "\",\"ino\":\"%" PRIu64 "\",\"size\":%" PRIu64 "}",
    capture_name, (uint64_t)captured.st_dev, (uint64_t)captured.st_ino, (uint64_t)captured.st_size);
  else printf("null");
  printf("}\n");
  fflush(stdout);
  int held = strcmp(status, "RACE_HELD") == 0;
  if (held) wait_for_recovery_ack();
  if (post_target_fd >= 0) close(post_target_fd);
  if (post_stage_fd >= 0) close(post_stage_fd);
  close(target_fd); close(stage_fd); close(retention); close(dirfd);
  return held ? 1 : 0;
}

static int acquire_lock(const char *directory, const char *dev, const char *ino) {
  struct stat dir_stat, lock_stat;
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail_directory("unsafe-lock-directory");
  int fd = openat(dirfd, ".skillopt-promotion.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0 || fstat(fd, &lock_stat) || !S_ISREG(lock_stat.st_mode) || lock_stat.st_nlink != 1 ||
      lock_stat.st_uid != getuid() || (lock_stat.st_mode & 0777) != 0600) {
    if (fd >= 0) close(fd);
    close(dirfd);
    return fail("unsafe-lock-file");
  }
  if (flock(fd, LOCK_EX | LOCK_NB)) {
    close(fd); close(dirfd);
    return 73;
  }
  if (printf("LOCKED\n") < 0 || fflush(stdout)) {
    flock(fd, LOCK_UN); close(fd); close(dirfd);
    return fail("lock-handshake-failed");
  }
  char buffer[64];
  while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) { }
  (void)flock(fd, LOCK_UN);
  close(fd);
  close(dirfd);
  return 0;
}

/* These report OS access results, not admission or proof of a role profile. */
static int probe_result(int error) {
  if (printf("%d\n", error) < 0) return 1;
  return error ? 1 : 0;
}

static int probe_access(const char *path, int write_access) {
  int fd = open(path, (write_access ? O_WRONLY : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return probe_result(errno);
  int error = 0;
  unsigned char byte;
  if (!write_access && read(fd, &byte, 1) < 0) error = errno;
  close(fd);
  return probe_result(error);
}

static int probe_connect(const char *host, const char *port_text) {
  uint64_t port;
  if (!port_text[0] || strspn(port_text, "0123456789") != strlen(port_text) ||
      parse_u64(port_text, &port) || port == 0 || port > 65535) return probe_result(EINVAL);
  struct sockaddr_storage storage;
  memset(&storage, 0, sizeof(storage));
  struct sockaddr_in *ipv4 = (struct sockaddr_in *)&storage;
  struct sockaddr_in6 *ipv6 = (struct sockaddr_in6 *)&storage;
  socklen_t length;
  int family;
  if (inet_pton(AF_INET, host, &ipv4->sin_addr) == 1) {
    family = AF_INET;
    ipv4->sin_family = AF_INET;
    ipv4->sin_port = htons((uint16_t)port);
    length = sizeof(*ipv4);
  } else if (inet_pton(AF_INET6, host, &ipv6->sin6_addr) == 1) {
    family = AF_INET6;
    ipv6->sin6_family = AF_INET6;
    ipv6->sin6_port = htons((uint16_t)port);
    length = sizeof(*ipv6);
  } else return probe_result(EINVAL);
  int fd = socket(family, SOCK_STREAM, 0);
  if (fd < 0) return probe_result(errno);
  int error = 0;
  if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0) error = errno;
  else if (connect(fd, (struct sockaddr *)&storage, length) < 0) {
    error = errno;
    if (error == EINPROGRESS) {
      struct pollfd pending = {.fd = fd, .events = POLLOUT};
      int ready = poll(&pending, 1, 1000);
      if (ready == 0) error = ETIMEDOUT;
      else if (ready < 0) error = errno;
      else {
        socklen_t size = sizeof(error);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) < 0) error = errno;
      }
    }
  }
  close(fd);
  return probe_result(error);
}

static int print_protocol(void) {
  if (printf("{\"protocol\":\"%s\",\"platform\":\"%s\"}\n", PROTOCOL, NATIVE_PLATFORM) < 0) {
    return fail("write-output-failed");
  }
  return 0;
}

static int print_clock(void) {
  char boot_id[CLOCK_ID_MAX + 1];
  uint64_t continuous_ns, wall_ms;
  if (native_clock(boot_id, &continuous_ns, &wall_ms)) return fail("clock-unavailable");
  if (printf("{\"protocol\":\"%s\",\"platform\":\"%s\",\"bootId\":\"%s\",\"continuousNanoseconds\":\"%" PRIu64
      "\",\"wallMilliseconds\":\"%" PRIu64 "\"}\n",
      PROTOCOL, NATIVE_PLATFORM, boot_id, continuous_ns, wall_ms) < 0) return fail("write-output-failed");
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc == 3 && strcmp(argv[1], "probe-read") == 0) return probe_access(argv[2], 0);
  if (argc == 3 && strcmp(argv[1], "probe-write") == 0) return probe_access(argv[2], 1);
  if (argc == 4 && strcmp(argv[1], "probe-connect") == 0) return probe_connect(argv[2], argv[3]);
  if (argc == 2 && strcmp(argv[1], "protocol") == 0) return print_protocol();
  if (argc == 2 && strcmp(argv[1], "clock") == 0) return print_clock();
  if (argc == 5 && strcmp(argv[1], "lock") == 0) return acquire_lock(argv[2], argv[3], argv[4]);
  if (argc == 5 && strcmp(argv[1], "probe") == 0) return probe_directory(argv[2], argv[3], argv[4]);
  if (argc == 5 && strcmp(argv[1], "sync-dir") == 0) return sync_directory(argv[2], argv[3], argv[4]);
  if (argc == 6 && strcmp(argv[1], "inspect") == 0) return inspect_file(argv[2], argv[3], argv[4], argv[5]);
  if (argc == 8 && strcmp(argv[1], "flush-file") == 0) return flush_file(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7]);
  if (argc == 15 && strcmp(argv[1], "exchange") == 0) {
    return exchange_files(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8], argv[9], argv[10],
      argv[11], argv[12], argv[13], argv[14]);
  }
  return fail("invalid-helper-command");
}
