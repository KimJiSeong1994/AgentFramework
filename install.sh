#!/usr/bin/env bash
# Otter installer: one command installs or updates `otter`.
#
#   gh api repos/KimJiSeong1994/AgentFramework/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#
# It clones (or updates) this repository into $OTTER_HOME, installs the runtime dependencies with bun, and writes a
# `otter` launcher into $OTTER_BIN_DIR. Re-running it updates in place. `install.sh --uninstall` removes what it created
# and keeps your config (~/.config/otter) and session state (~/.local/state/otter).
#
# Environment:
#   OTTER_REPO            git URL to install from (default: https://github.com/KimJiSeong1994/AgentFramework.git)
#   OTTER_REF             branch, tag or commit (default: master)
#   OTTER_HOME            install root (default: ~/.local/share/otter); the checkout is $OTTER_HOME/AgentFramework
#   OTTER_BIN_DIR         launcher directory (default: ~/.local/bin)
#   OTTER_NO_MODIFY_PATH  set to 1 to never edit a shell rc file
#   OTTER_NO_BUN_INSTALL  set to 1 to fail instead of installing bun when it is missing
#   OTTER_FORCE           set to 1 to replace an existing `otter` launcher this installer did not create
set -euo pipefail

REPO="${OTTER_REPO:-https://github.com/KimJiSeong1994/AgentFramework.git}"
REF="${OTTER_REF:-master}"
OTTER_HOME="${OTTER_HOME:-$HOME/.local/share/otter}"
BIN_DIR="${OTTER_BIN_DIR:-$HOME/.local/bin}"
DIR="$OTTER_HOME/AgentFramework"
SHIM="$BIN_DIR/otter"
MARKER="# managed by the otter installer (install.sh)"
BLOCK_BEGIN="# >>> otter installer >>>"
BLOCK_END="# <<< otter installer <<<"
BUN_MIN_MAJOR=1
BUN_MIN_MINOR=2

say() { printf '\033[1mlca:\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mlca:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mlca:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  printf '\nUsage: install.sh [--uninstall | --help]\n'
}

# Single-quote a value for a generated shell script.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# git with GitHub CLI credentials when gh is signed in, so a private repository clones without a prompt.
# Never prompt on the terminal: when piped into bash, stdin is this script.
git_auth() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    GIT_TERMINAL_PROMPT=0 git -c "credential.https://github.com.helper=" \
      -c "credential.https://github.com.helper=!gh auth git-credential" "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

check_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in Darwin|Linux) ;; *) die "unsupported OS: $os (macOS and Linux are supported)" ;; esac
  case "$arch" in arm64|aarch64|x86_64|amd64) ;; *) die "unsupported CPU architecture: $arch" ;; esac
}

bun_ok() {
  local version major minor
  version="$("$1" --version 2>/dev/null)" || return 1
  major="${version%%.*}"; minor="${version#*.}"; minor="${minor%%.*}"
  case "$major$minor" in *[!0-9]*|"") return 1 ;; esac
  [ "$major" -gt "$BUN_MIN_MAJOR" ] || { [ "$major" -eq "$BUN_MIN_MAJOR" ] && [ "$minor" -ge "$BUN_MIN_MINOR" ]; }
}

ensure_bun() {
  local candidate
  for candidate in "$(command -v bun 2>/dev/null || true)" "${BUN_INSTALL:-$HOME/.bun}/bin/bun"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && bun_ok "$candidate"; then BUN="$candidate"; return; fi
  done
  [ "${OTTER_NO_BUN_INSTALL:-}" = "1" ] && die "bun >= $BUN_MIN_MAJOR.$BUN_MIN_MINOR is required: https://bun.sh"
  command -v curl >/dev/null 2>&1 || die "curl is required to install bun"
  say "installing bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  candidate="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  [ -x "$candidate" ] && bun_ok "$candidate" || die "bun installation failed; install it from https://bun.sh and re-run"
  BUN="$candidate"
}

managed_checkout() { [ -f "$DIR/.git/otter-installer" ]; }

fetch_source() {
  local created=0
  if [ -e "$DIR" ] && ! managed_checkout; then
    die "$DIR exists and was not created by this installer; move it or set OTTER_HOME"
  fi
  if [ ! -e "$DIR" ]; then
    mkdir -p "$DIR"
    created=1
    git -C "$DIR" init -q
    git -C "$DIR" remote add origin "$REPO"
    printf 'repo=%s\n' "$REPO" > "$DIR/.git/otter-installer"
  else
    [ -z "$(git -C "$DIR" status --porcelain)" ] || die "$DIR has local changes; commit or discard them before updating"
    git -C "$DIR" remote set-url origin "$REPO"
  fi
  say "fetching $REF from $REPO"
  if ! git_auth -C "$DIR" fetch -q --depth 1 origin "$REF"; then
    [ "$created" = 1 ] && rm -rf "$DIR"
    die "could not fetch $REPO ($REF). For a private repository sign in first (gh auth login), or use an SSH URL: OTTER_REPO=git@github.com:KimJiSeong1994/AgentFramework.git"
  fi
  git -C "$DIR" checkout -q --force --detach FETCH_HEAD
  say "source at $(git -C "$DIR" rev-parse --short HEAD)"
}

install_deps() {
  say "installing runtime dependencies"
  (cd "$DIR/framework" && "$BUN" install --frozen-lockfile --production >/dev/null) ||
    die "bun install failed in $DIR/framework"
}

shim_owned() { [ -f "$SHIM" ] && grep -qF "$MARKER" "$SHIM"; }

install_shim() {
  if [ -e "$SHIM" ] && ! shim_owned && [ "${OTTER_FORCE:-}" != "1" ]; then
    die "$SHIM already exists and was not created by this installer; remove it or re-run with OTTER_FORCE=1"
  fi
  mkdir -p "$BIN_DIR"
  local tmp="$SHIM.tmp.$$"
  {
    printf '#!/bin/sh\n%s\n' "$MARKER"
    printf 'bun=%s\n' "$(shq "$BUN")"
    printf '[ -x "$bun" ] || bun="$(command -v bun)" || { echo "otter: bun not found; re-run the otter installer" >&2; exit 127; }\n'
    printf 'exec "$bun" %s "$@"\n' "$(shq "$DIR/framework/src/hosts/cli.ts")"
  } > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$SHIM"
}

rc_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [ "$(uname -s)" = Darwin ] && printf '%s\n' "$HOME/.bash_profile" || printf '%s\n' "$HOME/.bashrc" ;;
    fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/otter.fish" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

ensure_path() {
  case ":$PATH:" in *":$BIN_DIR:"*) return ;; esac
  local rc
  rc="$(rc_file)"
  if [ "${OTTER_NO_MODIFY_PATH:-}" = "1" ]; then
    warn "$BIN_DIR is not on PATH; add it to use \`otter\`"
    return
  fi
  if [ ! -f "$rc" ] || ! grep -qF "$BLOCK_BEGIN" "$rc"; then
    mkdir -p "$(dirname "$rc")"
    if [ "${rc##*.}" = fish ]; then
      printf '%s\nfish_add_path %s\n%s\n' "$BLOCK_BEGIN" "$(shq "$BIN_DIR")" "$BLOCK_END" >> "$rc"
    else
      printf '\n%s\nexport PATH=%s:"$PATH"\n%s\n' "$BLOCK_BEGIN" "$(shq "$BIN_DIR")" "$BLOCK_END" >> "$rc"
    fi
    say "added $BIN_DIR to PATH in $rc"
  fi
  warn "open a new terminal (or run: export PATH=\"$BIN_DIR:\$PATH\") to use \`otter\`"
}

report_engines() {
  local found="" name
  for name in ollama codex claude; do command -v "$name" >/dev/null 2>&1 && found="$found $name"; done
  if [ -n "$found" ]; then say "engines found:$found"
  else warn "no engine CLI found; install at least one of ollama (local), codex, or claude"; fi
}

uninstall() {
  if shim_owned; then rm -f "$SHIM"; say "removed $SHIM"
  elif [ -e "$SHIM" ]; then warn "kept $SHIM (not created by this installer)"; fi
  if managed_checkout; then rm -rf "$DIR"; say "removed $DIR"
  elif [ -e "$DIR" ]; then warn "kept $DIR (not created by this installer)"; fi
  rmdir "$OTTER_HOME" 2>/dev/null || true
  local rc
  rc="$(rc_file)"
  if [ -f "$rc" ] && grep -qF "$BLOCK_BEGIN" "$rc"; then
    if [ "${rc##*.}" = fish ]; then rm -f "$rc"
    else
      awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '$0 == begin {skip = 1; next} $0 == end {skip = 0; next} !skip' "$rc" > "$rc.otter.tmp"
      mv -f "$rc.otter.tmp" "$rc"
    fi
    say "removed the PATH entry from $rc"
  fi
  say "config (~/.config/otter) and session state (~/.local/state/otter) were kept"
}

main() {
  case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --uninstall) uninstall; exit 0 ;;
    "") ;;
    *) usage >&2; exit 2 ;;
  esac
  check_platform
  command -v git >/dev/null 2>&1 || die "git is required"
  ensure_bun
  fetch_source
  install_deps
  install_shim
  "$SHIM" --help >/dev/null 2>&1 || die "installed launcher failed to start: $SHIM --help"
  say "installed: $SHIM"
  ensure_path
  report_engines
  say "start with: otter"
}

main "$@"
