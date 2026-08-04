#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="OpenZCAD"
APP_PROCESS="openzcad-desktop"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
APP_BUNDLE="$DESKTOP_DIR/src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/$APP_NAME.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$APP_PROCESS"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required but is not available on PATH." >&2
    exit 1
  fi
}

require_command node
require_command pnpm
require_command cargo

if ! NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null)"; then
  echo "Node could not start. Activate a supported Node 20 or 22 installation and retry." >&2
  exit 1
fi
NODE_MAJOR="${NODE_VERSION%%.*}"
if (( NODE_MAJOR < 20 )); then
  echo "OpenZCAD requires Node 20.19+ or 22.12+; found $NODE_VERSION." >&2
  exit 1
fi

pkill -x "$APP_PROCESS" >/dev/null 2>&1 || true
pnpm --dir "$DESKTOP_DIR" build:debug

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "The Tauri build completed without producing $APP_BUNDLE." >&2
  exit 1
fi

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_EXECUTABLE"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "app.esau.openzcad"'
    ;;
  --verify|verify)
    open_app
    for _ in 1 2 3 4 5; do
      if pgrep -x "$APP_PROCESS" >/dev/null; then
        exit 0
      fi
      sleep 1
    done
    echo "$APP_NAME did not remain running after launch." >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
