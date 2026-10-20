# Windup Monitor — project-local tool caches on the data disk.
#
# Usage (source it, do not execute it):
#
#     . scripts/env.sh
#
# Why: the system disk `/` is small (~13 GiB, frequently ~98% full), while the
# data disk `/mnt/ai_data` holds the repository and has ample headroom. This
# wrapper redirects the heavy build caches used by *this project only* to
# `<repo>/.cache` (on the data disk). Global caches shared with other projects
# (`~/.npm`, `~/.cache/go-build`, `~/go`) are intentionally left untouched.
#
# Overridable: set WINDUP_MONITOR_REPO=/path/to/repo before sourcing if the
# automatic repository-root detection does not fit your shell. The legacy
# STATUSPILOT_REPO variable is still accepted for existing shells/scripts.

# --- resolve the repository root (works when sourced from bash/zsh/sh) -------
_windup_monitor_repo_root="${WINDUP_MONITOR_REPO:-${STATUSPILOT_REPO:-}}"
if [ -z "$_windup_monitor_repo_root" ]; then
  if [ -n "${BASH_SOURCE:-}" ]; then
    _windup_monitor_repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
  elif [ -n "${ZSH_VERSION:-}" ]; then
    _windup_monitor_repo_root=$(CDPATH= cd -- "$(dirname -- "${(%):-%x}")/.." && pwd)
  else
    _windup_monitor_repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  fi
fi

_windup_monitor_cache="$_windup_monitor_repo_root/.cache"

# --- redirect Go / npm / temp caches to the data disk ------------------------
export GOCACHE="$_windup_monitor_cache/go-build"
export GOMODCACHE="$_windup_monitor_cache/go-mod"
export npm_config_cache="$_windup_monitor_cache/npm"
export TMPDIR="$_windup_monitor_cache/tmp"

mkdir -p "$GOCACHE" "$GOMODCACHE" "$npm_config_cache" "$TMPDIR"

unset _windup_monitor_cache
