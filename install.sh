#!/bin/sh
# agentsmd installer: fetch a pinned, checksum-verified release artifact, then
# run the marker-scoped Node installer/uninstaller. Re-running install is the
# update path.
#
# Artifact identity (R3-01/R3-02): the default ref is this script's own release
# tag, resolved to the immutable GitHub release asset built by CI at tag time,
# and its SHA-256 is verified BEFORE any downloaded code executes. A mutable
# branch ref (e.g. main) runs only with an explicit --dev and a standing
# warning; a 40-hex commit is immutable by identity but has no published
# checksum and also warns.

set -eu

NAME="agentsmd"
DEFAULT_REPO="sdsrss/agentsmd"
# Synchronized by scripts/version-sync.js — must equal package.json version.
INSTALLER_VERSION="4.9.0"
DEFAULT_REF="v$INSTALLER_VERSION"

ACTION="install"
ACTION_OPTION=""
REPO="${AGENTSMD_REPO:-$DEFAULT_REPO}"
REF="${AGENTSMD_REF:-$DEFAULT_REF}"
SOURCE_DIR="${AGENTSMD_SOURCE_DIR:-}"
DEV_MODE=0
DEGRADED_MODE=""
TMP_ROOT=""
SRC_PATH=""
RESOLVED_IDENTITY=""
# An explicit --repo/--ref (or env override) asks for a download: the local
# checkout shortcut must not silently shadow it (it once installed a working
# tree into the live CODEX_HOME when a pinned ref was requested).
FETCH_EXPLICIT=0
[ -z "${AGENTSMD_REPO:-}" ] && [ -z "${AGENTSMD_REF:-}" ] || FETCH_EXPLICIT=1

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
  --ref <ref>         Release tag (vX.Y.Z, checksum-verified), 40-hex commit, or
                      — with --dev only — a mutable branch. Default: this
                      script's own release tag.
  --dev               Allow a mutable branch ref (e.g. --ref main). No pinning,
                      no checksum — development use only.
  --degraded          Explicitly allow installing with missing prerequisites
                      (jq, node >= 18). Hooks FAIL OPEN — no §8 enforcement;
                      status/doctor keep warning until a healthy update. By
                      default a missing prerequisite aborts with ZERO changes.
  --source <dir>      Use a local checkout instead of downloading. Used by tests/dev.
  -y, --yes           Non-interactive compatibility flag. The installer never prompts.
  -h, --help          Show this help.

Environment:
  CODEX_HOME          Codex config directory. Default: ~/.codex.
  AGENTSMD_REPO       Override the GitHub repo/source.
  AGENTSMD_REF        Override the Git ref.
  AGENTSMD_SOURCE_DIR Use a local checkout instead of downloading.
  AGENTSMD_RELEASE_BASE  Override the release-asset base URL (tests/mirrors).

Notes:
  --update, --uninstall, --status, and --doctor are mutually exclusive.
  Release tags download the immutable GitHub release asset and verify its
  published SHA-256 before any downloaded code runs.
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

# Classify a ref for artifact-identity purposes: release-tag (immutable +
# checksummed), commit (immutable identity, no published checksum), or mutable
# (branches and everything else — --dev only).
ref_kind() {
  case "$1" in
    v[0-9]*.[0-9]*.[0-9]*) printf 'tag\n' ;;
    *)
      case "$1" in
        *[!0-9a-f]*) printf 'mutable\n' ;;
        *)
          if [ "${#1}" -eq 40 ]; then printf 'commit\n'; else printf 'mutable\n'; fi
          ;;
      esac
      ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "missing sha256sum or shasum; cannot verify the release checksum"
  fi
}

# Repo shorthand/URL → "owner/project", or fail for unsupported values.
repo_slug() {
  repo="$1"
  case "$repo" in
    https://github.com/*/*|http://github.com/*/*)
      rest=${repo#https://github.com/}
      rest=${rest#http://github.com/}
      ;;
    git@github.com:*/*)
      rest=${repo#git@github.com:}
      ;;
    */*)
      rest=$repo
      ;;
    *)
      return 1
      ;;
  esac
  rest=${rest%.git}
  owner=${rest%%/*}
  project=${rest#*/}
  project=${project%%/*}
  printf '%s/%s\n' "$owner" "$project"
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

# Release-tag path (R3-02): download the immutable GitHub release asset plus its
# published .sha256 and verify BEFORE unpacking or executing anything from it.
fetch_release_asset() {
  tag="$1"
  version=${tag#v}
  slug=$(repo_slug "$REPO") || die "unsupported --repo value: $REPO"
  base="${AGENTSMD_RELEASE_BASE:-https://github.com/$slug/releases/download}"
  asset="agentsmd-$version.tgz"
  archive="$TMP_ROOT/$asset"
  sums="$TMP_ROOT/$asset.sha256"

  printf 'Downloading %s release asset %s@%s\n' "$NAME" "$slug" "$tag" >&2
  download_to "$base/$tag/$asset" "$archive" \
    || die "download failed: $base/$tag/$asset (releases before v4.6.0 have no asset — use npm i -g @sdsrs/agentsmd, or --ref <40-hex-commit>)"
  download_to "$base/$tag/$asset.sha256" "$sums" \
    || die "download failed: $base/$tag/$asset.sha256"

  expected=$(cut -d' ' -f1 < "$sums" | sed -n '1p')
  case "$expected" in
    *[!0-9a-f]*|'') die "published checksum file is malformed: $asset.sha256" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "published checksum file is malformed: $asset.sha256"
  actual=$(sha256_of "$archive")
  [ "$actual" = "$expected" ] \
    || die "SHA-256 mismatch for $asset: expected $expected, got $actual — refusing to execute"

  unpack="$TMP_ROOT/source"
  mkdir -p "$unpack"
  tar -xzf "$archive" -C "$unpack" || die "could not unpack verified archive"
  src="$unpack/package"
  [ -f "$src/scripts/install.js" ] || die "verified archive is missing scripts/install.js"

  pkg_version=$(sed -n 's/^  "version": "\([0-9][^"]*\)",$/\1/p' "$src/package.json" | sed -n '1p')
  [ "$pkg_version" = "$version" ] \
    || die "release identity mismatch: tag $tag carries package version $pkg_version"
  RESOLVED_IDENTITY="$NAME v$version ($tag, sha256 verified: $(printf '%s' "$actual" | cut -c1-12)…)"
  SRC_PATH="$src"
}

fetch_source() {
  if [ -n "$SOURCE_DIR" ]; then
    src=$(abs_dir "$SOURCE_DIR")
    [ -f "$src/scripts/install.js" ] || die "--source does not look like an agentsmd checkout: $src"
    SRC_PATH="$src"
    RESOLVED_IDENTITY="$NAME (local source: $src)"
    return 0
  fi

  if [ "$FETCH_EXPLICIT" -ne 1 ] && src=$(script_dir_source 2>/dev/null); then
    SRC_PATH="$src"
    RESOLVED_IDENTITY="$NAME (local checkout: $src)"
    return 0
  fi

  kind=$(ref_kind "$REF")
  if [ "$kind" = "mutable" ] && [ "$DEV_MODE" -ne 1 ]; then
    usage_die "--ref $REF is a mutable ref: it cannot be pinned or checksum-verified. Use the default release tag, a 40-hex commit, or pass --dev (development only)"
  fi

  need_cmd tar
  TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/agentsmd-install.XXXXXX") || die "could not create a temp directory"

  if [ "$kind" = "tag" ]; then
    fetch_release_asset "$REF"
    return 0
  fi

  if [ "$kind" = "commit" ]; then
    say "WARNING: --ref $REF is an immutable commit, but commits have no published"
    say "         SHA-256 — the archive content is not checksum-verified."
  else
    say "WARNING: --dev install from mutable ref '$REF' — NOT pinned, NOT"
    say "         checksum-verified. Whatever the ref points at right now will run."
  fi

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
  RESOLVED_IDENTITY="$NAME @ $REPO@$REF (UNVERIFIED $kind ref)"
  SRC_PATH="$src"
}

run_node_script() {
  src="$1"
  script="$2"
  shift 2
  need_node
  node "$src/scripts/$script" "$@"
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
      FETCH_EXPLICIT=1
      shift 2
      ;;
    --ref)
      require_option_value "$1" "${2:-}"
      REF="$2"
      FETCH_EXPLICIT=1
      shift 2
      ;;
    --source)
      require_option_value "$1" "${2:-}"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --dev)
      DEV_MODE=1
      shift
      ;;
    --degraded)
      DEGRADED_MODE=1
      shift
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
    [ -z "$RESOLVED_IDENTITY" ] || say "Resolved: $RESOLVED_IDENTITY"
    # Prerequisites (jq, node >= 18) gate inside install.js's shared preflight
    # (R1-03): a miss aborts BEFORE any $CODEX_HOME byte changes. --degraded is
    # the explicit opt-in for a NON-ENFORCING install (manifest enforcement:false).
    run_node_script "$src" install.js ${DEGRADED_MODE:+--degraded}
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
