#!/bin/sh
# agentsmd installer: fetch the current repo snapshot, then run the marker-scoped
# Node installer/uninstaller. Re-running install is the update path.

set -eu

NAME="agentsmd"
DEFAULT_REPO="sdsrss/agentsmd"
DEFAULT_REF="main"

ACTION="install"
ACTION_OPTION=""
REPO="${AGENTSMD_REPO:-$DEFAULT_REPO}"
REF="${AGENTSMD_REF:-$DEFAULT_REF}"
SOURCE_DIR="${AGENTSMD_SOURCE_DIR:-}"
TMP_ROOT=""
SRC_PATH=""

usage() {
  cat <<'EOF'
agentsmd installer

Usage:
  sh install.sh [options]

Install or update:
  curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

Uninstall:
  curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --uninstall

Options:
  --update            Same as install; refreshes agentsmd in CODEX_HOME.
  --uninstall         Remove agentsmd's hooks, skills, AGENTS.md block, install dir, and state.
  --status            Print the current agentsmd install status.
  --doctor            Run install health checks.
  --repo <repo>       GitHub repo shorthand or URL. Default: sdsrss/agentsmd.
  --ref <ref>         Git branch, tag, or commit to install. Default: main.
  --source <dir>      Use a local checkout instead of downloading. Used by tests/dev.
  -y, --yes           Non-interactive compatibility flag. The installer never prompts.
  -h, --help          Show this help.

Environment:
  CODEX_HOME          Codex config directory. Default: ~/.codex.
  AGENTSMD_REPO       Override the GitHub repo/source.
  AGENTSMD_REF        Override the Git ref.
  AGENTSMD_SOURCE_DIR Use a local checkout instead of downloading.

Notes:
  --update, --uninstall, --status, and --doctor are mutually exclusive.
  Exit status: 0 = success/help, 1 = runtime/health failure, 2 = argv/usage error.
  GitHub does not serve raw files from https://github.com/sdsrss/agentsmd/install.sh.
  Use the raw.githubusercontent.com URL above for curl-piped installs.
EOF
}

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'agentsmd installer: %s\n' "$*" >&2
  exit 1
}

usage_die() {
  printf 'agentsmd installer: %s\n' "$*" >&2
  exit 2
}

require_option_value() {
  option="$1"
  value="${2:-}"
  case "$value" in
    ''|-*) usage_die "$option requires a value" ;;
  esac
}

select_action() {
  option="$1"
  action="$2"
  if [ -n "$ACTION_OPTION" ]; then
    usage_die "multiple action options: $ACTION_OPTION and $option"
  fi
  ACTION_OPTION="$option"
  ACTION="$action"
}

cleanup() {
  if [ -n "${TMP_ROOT:-}" ] && [ -d "$TMP_ROOT" ]; then
    tmp_base=$(abs_dir "${TMPDIR:-/tmp}" 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}")
    case "$TMP_ROOT" in
      "$tmp_base"/agentsmd-install.*) rm -rf "$TMP_ROOT" ;;
    esac
  fi
}
trap cleanup EXIT INT TERM

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0\n'
}

need_node() {
  need_cmd node
  major="$(node_major)"
  case "$major" in
    ''|*[!0-9]*) die "could not determine Node.js version" ;;
  esac
  [ "$major" -ge 18 ] || die "Node.js >= 18 is required; found $(node -v 2>/dev/null || printf unknown)"
}

abs_dir() {
  [ -d "$1" ] || die "not a directory: $1"
  (cd "$1" >/dev/null 2>&1 && pwd) || die "cannot resolve directory: $1"
}

script_dir_source() {
  case "$0" in
    */*) d=$(dirname "$0") ;;
    *) d=. ;;
  esac
  d=$(abs_dir "$d")
  if [ -f "$d/scripts/install.js" ] && [ -f "$d/scripts/uninstall.js" ]; then
    printf '%s\n' "$d"
    return 0
  fi
  return 1
}

download_to() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    die "missing curl or wget; cannot download $url"
  fi
}

repo_archive_url() {
  repo="$1"
  ref="$2"
  case "$repo" in
    https://github.com/*/*|http://github.com/*/*)
      rest=${repo#https://github.com/}
      rest=${rest#http://github.com/}
      rest=${rest%.git}
      owner=${rest%%/*}
      project=${rest#*/}
      project=${project%%/*}
      printf 'https://codeload.github.com/%s/%s/tar.gz/%s\n' "$owner" "$project" "$ref"
      ;;
    git@github.com:*/*)
      rest=${repo#git@github.com:}
      rest=${rest%.git}
      owner=${rest%%/*}
      project=${rest#*/}
      project=${project%%/*}
      printf 'https://codeload.github.com/%s/%s/tar.gz/%s\n' "$owner" "$project" "$ref"
      ;;
    */*)
      rest=${repo%.git}
      owner=${rest%%/*}
      project=${rest#*/}
      project=${project%%/*}
      printf 'https://codeload.github.com/%s/%s/tar.gz/%s\n' "$owner" "$project" "$ref"
      ;;
    *)
      return 1
      ;;
  esac
}

fetch_source() {
  if [ -n "$SOURCE_DIR" ]; then
    src=$(abs_dir "$SOURCE_DIR")
    [ -f "$src/scripts/install.js" ] || die "--source does not look like an agentsmd checkout: $src"
    SRC_PATH="$src"
    return 0
  fi

  if src=$(script_dir_source 2>/dev/null); then
    SRC_PATH="$src"
    return 0
  fi

  need_cmd tar
  TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/agentsmd-install.XXXXXX") || die "could not create a temp directory"
  archive="$TMP_ROOT/source.tar.gz"
  unpack="$TMP_ROOT/source"
  mkdir -p "$unpack"

  url=$(repo_archive_url "$REPO" "$REF") || die "unsupported --repo value: $REPO"
  printf 'Downloading %s from %s@%s\n' "$NAME" "$REPO" "$REF" >&2
  download_to "$url" "$archive" || die "download failed: $url"
  tar -xzf "$archive" -C "$unpack" || die "could not unpack downloaded archive"
  src=$(find "$unpack" -mindepth 1 -maxdepth 1 -type d | sed -n '1p')
  [ -n "$src" ] || die "downloaded archive did not contain a source directory"
  [ -f "$src/scripts/install.js" ] || die "downloaded archive is missing scripts/install.js"
  SRC_PATH="$src"
}

run_node_script() {
  src="$1"
  script="$2"
  need_node
  node "$src/scripts/$script"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --update)
      select_action "--update" "install"
      shift
      ;;
    --uninstall)
      select_action "--uninstall" "uninstall"
      shift
      ;;
    --status)
      select_action "--status" "status"
      shift
      ;;
    --doctor)
      select_action "--doctor" "doctor"
      shift
      ;;
    --repo)
      require_option_value "$1" "${2:-}"
      REPO="$2"
      shift 2
      ;;
    --ref)
      require_option_value "$1" "${2:-}"
      REF="$2"
      shift 2
      ;;
    --source)
      require_option_value "$1" "${2:-}"
      SOURCE_DIR="$2"
      shift 2
      ;;
    -y|--yes)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_die "unknown option: $1 (run with --help)"
      ;;
  esac
done

fetch_source
src="$SRC_PATH"
if [ -n "${CODEX_HOME:-}" ]; then
  codex_home=$CODEX_HOME
else
  [ -n "${HOME:-}" ] || die "HOME is not set; set CODEX_HOME explicitly"
  codex_home="$HOME/.codex"
fi

case "$ACTION" in
  install)
    say "Installing/updating $NAME into $codex_home"
    if ! command -v jq >/dev/null 2>&1; then
      say "WARNING: jq was not found on PATH. agentsmd's hooks require jq; without it every"
      say "         hook fails open (NO enforcement) — the silent non-enforcing install this"
      say "         project exists to prevent. Install jq, then re-run: $0 --doctor"
    fi
    run_node_script "$src" install.js
    say ""
    say "Verifying install (doctor):"
    if run_node_script "$src" doctor.js; then
      say ""
      say "$NAME is installed and healthy (run scripts/status.js for details)."
      say "Start a new Codex session to load it."
    else
      say ""
      say "doctor reported issues above — fix them, then re-run: $0 --doctor"
      exit 1
    fi
    ;;
  uninstall)
    say "Uninstalling $NAME from $codex_home"
    run_node_script "$src" uninstall.js
    ;;
  status)
    run_node_script "$src" status.js
    ;;
  doctor)
    run_node_script "$src" doctor.js
    ;;
  *)
    die "internal error: unsupported action $ACTION"
    ;;
esac

exit 0
