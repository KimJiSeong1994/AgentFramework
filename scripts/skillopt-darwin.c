#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/mount.h>
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

#ifndef F_FULLFSYNC
#error "F_FULLFSYNC is required; this helper must not build without it"
#endif
#ifndef RENAME_SWAP
#define RENAME_SWAP 0x00000002
#endif

#define MAX_SKILL_BYTES 16384
#define PROTOCOL "skillopt-darwin.v2"

static int fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  return 1;
}

static int parse_u64(const char *text, uint64_t *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno || !text[0] || !end || *end) return -1;
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
  if (parse_u64(dev_text, &expected_dev) || parse_u64(ino_text, &expected_ino)) return -1;
  if (!realpath(path, canonical) || strcmp(path, canonical) != 0) return -1;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  if (fstat(fd, result) || !S_ISDIR(result->st_mode) || (uint64_t)result->st_dev != expected_dev ||
      (uint64_t)result->st_ino != expected_ino || result->st_uid != getuid()) {
    close(fd);
    return -1;
  }
  return fd;
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino && left->st_mode == right->st_mode &&
    left->st_nlink == right->st_nlink && left->st_uid == right->st_uid && left->st_size == right->st_size &&
    left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec && left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
    left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec && left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
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
  if (fcntl(fd, F_FULLFSYNC) == -1) return -1;
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
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail("unsafe-directory");
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
  if (printf("{\"dev\":\"%" PRIu64 "\",\"ino\":\"%" PRIu64 "\",\"uid\":%u,\"mode\":%u,\"nlink\":%u,\"size\":%" PRIu64 ",\"mtimeNs\":\"%" PRId64 "\",\"ctimeNs\":\"%" PRId64 "\",\"base64\":\"",
      (uint64_t)after.st_dev, (uint64_t)after.st_ino, (unsigned int)after.st_uid, (unsigned int)after.st_mode,
      (unsigned int)after.st_nlink, (uint64_t)after.st_size,
      (int64_t)after.st_mtimespec.tv_sec * 1000000000LL + after.st_mtimespec.tv_nsec,
      (int64_t)after.st_ctimespec.tv_sec * 1000000000LL + after.st_ctimespec.tv_nsec) < 0 ||
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
  if (fd < 0) return fail("unsafe-directory");
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
  if (dirfd < 0) return fail("unsafe-directory");
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

static int probe_directory(const char *directory, const char *dev, const char *ino) {
  struct stat dir_stat, first_stat, second_stat, after_first, after_second;
  struct statfs filesystem;
  int dirfd = open_directory(directory, dev, ino, &dir_stat);
  if (dirfd < 0) return fail("unsafe-directory");
  if (fstatfs(dirfd, &filesystem) || strcmp(filesystem.f_fstypename, "apfs") != 0) {
    close(dirfd);
    return fail("probe-requires-apfs");
  }
  if (fsync(dirfd)) { close(dirfd); return fail("directory-fsync-unsupported"); }
  char first_name[NAME_MAX], second_name[NAME_MAX];
  unsigned char random[12];
  arc4random_buf(random, sizeof(random));
  (void)snprintf(first_name, sizeof(first_name), ".skillopt-probe-%ld-%02x%02x%02x%02x-a", (long)getpid(), random[0], random[1], random[2], random[3]);
  (void)snprintf(second_name, sizeof(second_name), ".skillopt-probe-%ld-%02x%02x%02x%02x-b", (long)getpid(), random[0], random[1], random[2], random[3]);
  int first_fd = openat(dirfd, first_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (first_fd < 0 || fstat(first_fd, &first_stat) || !S_ISREG(first_stat.st_mode) || first_stat.st_nlink != 1 || first_stat.st_uid != getuid()) {
    if (first_fd >= 0) close(first_fd);
    close(dirfd);
    return fail("probe-create-failed");
  }
  int second_fd = openat(dirfd, second_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (second_fd < 0 || fstat(second_fd, &second_stat) || !S_ISREG(second_stat.st_mode) || second_stat.st_nlink != 1 || second_stat.st_uid != getuid()) {
    close(first_fd);
    if (second_fd >= 0) close(second_fd);
    close(dirfd);
    return fail("probe-create-failed");
  }
  const unsigned char first_marker = 0x35, second_marker = 0x6a;
  int result = write(first_fd, &first_marker, 1) == 1 && write(second_fd, &second_marker, 1) == 1 ? 0 : -1;
  if (!result && (flush_fd(first_fd) || flush_fd(second_fd))) result = -1;
  if (!result && (fstat(first_fd, &first_stat) || fstat(second_fd, &second_stat))) result = -1;
  if (close(first_fd)) result = -1;
  if (close(second_fd)) result = -1;
  if (fsync(dirfd)) result = -1;
  int first_read_fd = -1, second_read_fd = -1;
  if (!result) {
    first_read_fd = open_regular_at(dirfd, &dir_stat, first_name, &after_first);
    second_read_fd = open_regular_at(dirfd, &dir_stat, second_name, &after_second);
    if (first_read_fd < 0 || second_read_fd < 0 || !same_stat(&first_stat, &after_first) || !same_stat(&second_stat, &after_second)) result = -1;
  }
  if (!result && renameatx_np(dirfd, second_name, dirfd, first_name, RENAME_SWAP)) result = -1;
  if (!result && fsync(dirfd)) result = -1;
  int first_post_fd = -1, second_post_fd = -1;
  struct stat first_post_stat, second_post_stat;
  if (!result) {
    first_post_fd = open_regular_at(dirfd, &dir_stat, first_name, &first_post_stat);
    second_post_fd = open_regular_at(dirfd, &dir_stat, second_name, &second_post_stat);
    unsigned char first_byte = 0, second_byte = 0;
    if (first_post_fd < 0 || second_post_fd < 0 || first_post_stat.st_ino != second_stat.st_ino ||
        second_post_stat.st_ino != first_stat.st_ino || pread(first_post_fd, &first_byte, 1, 0) != 1 ||
        pread(second_post_fd, &second_byte, 1, 0) != 1 || first_byte != second_marker || second_byte != first_marker) result = -1;
  }
  if (first_post_fd >= 0 && flush_fd(first_post_fd)) result = -1;
  if (second_post_fd >= 0 && flush_fd(second_post_fd)) result = -1;
  if (first_read_fd >= 0) close(first_read_fd);
  if (second_read_fd >= 0) close(second_read_fd);
  if (first_post_fd >= 0) close(first_post_fd);
  if (second_post_fd >= 0) close(second_post_fd);
  /* Probe artifacts intentionally remain in the caller-owned disposable scratch directory. */
  if (fsync(dirfd)) result = -1;
  struct stat after;
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
  int fd = open(ready, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
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

static void print_snapshot(const struct stat *st) {
  if (!st) { printf("null"); return; }
  printf("{\"dev\":\"%" PRIu64 "\",\"ino\":\"%" PRIu64 "\",\"uid\":%u,\"mode\":%u,\"nlink\":%u,\"size\":%" PRIu64
    ",\"mtimeNs\":\"%" PRId64 "\",\"ctimeNs\":\"%" PRId64 "\"}",
    (uint64_t)st->st_dev, (uint64_t)st->st_ino, (unsigned)st->st_uid, (unsigned)st->st_mode,
    (unsigned)st->st_nlink, (uint64_t)st->st_size,
    (int64_t)st->st_mtimespec.tv_sec * 1000000000LL + st->st_mtimespec.tv_nsec,
    (int64_t)st->st_ctimespec.tv_sec * 1000000000LL + st->st_ctimespec.tv_nsec);
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
  if (dirfd < 0) return fail("unsafe-directory");
  int retention = open_directory(retention_path, retention_dev, retention_ino, &retention_stat);
  if (retention < 0 || (retention_stat.st_mode & 0777) != 0700) {
    if (retention >= 0) close(retention);
    close(dirfd);
    return fail("unsafe-retention-directory");
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
  exchange_test_boundary("before-swap");
  if (renameatx_np(dirfd, stage, dirfd, target, RENAME_SWAP)) {
    close(target_fd); close(stage_fd); close(retention); close(dirfd);
    return fail("renameatx-swap-failed");
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
  const char *status = "EXCHANGED", *reason = NULL;
  if (!target_named || (!stage_named && !capture_ok)) { status = "RACE_HELD"; reason = "post-swap-inspection-failed"; }
  else if (unexpected_stage && !capture_ok) { status = "RACE_HELD"; reason = "capture-unavailable"; }
  else if (result || target_after.st_dev != stage_before.st_dev || target_after.st_ino != stage_before.st_ino) {
    status = "RACE_HELD"; reason = "exchange-durability-failed";
  } else if (capture_ok) { status = "RACE_CAPTURED"; reason = "unexpected-displaced-inode"; }
  printf("{\"protocol\":\"%s\",\"status\":\"%s\",\"exchangeOccurred\":true,\"reason\":", PROTOCOL, status);
  if (reason) printf("\"%s\"", reason); else printf("null");
  printf(",\"target\":"); print_snapshot(post_target_fd >= 0 ? &target_after : NULL);
  printf(",\"stage\":"); print_snapshot(post_stage_fd >= 0 ? &stage_after : NULL);
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
  if (dirfd < 0) return fail("unsafe-lock-directory");
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

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc == 3 && strcmp(argv[1], "probe-read") == 0) return probe_access(argv[2], 0);
  if (argc == 3 && strcmp(argv[1], "probe-write") == 0) return probe_access(argv[2], 1);
  if (argc == 4 && strcmp(argv[1], "probe-connect") == 0) return probe_connect(argv[2], argv[3]);
  if (argc == 2 && strcmp(argv[1], "protocol") == 0) {
    (void)printf("%s\n", PROTOCOL);
    return 0;
  }
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
