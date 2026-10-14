#!/bin/bash
# Chadoodle-iOS bauen und aufs iPhone installieren (in WSL/Linux mit xtool, siehe ios/README.md).
# Gebaut wird in einer Kopie unter ~/chadoodle-ios: SwiftPM-Builds im OneDrive-Ordner sind langsam.
set -euo pipefail
[ -f "$HOME/.local/share/swiftly/env.sh" ] && . "$HOME/.local/share/swiftly/env.sh"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/chadoodle-ios"
mkdir -p "$DEST"
cp -r "$SRC/Package.swift" "$SRC/xtool.yml" "$SRC/Info.plist" "$SRC/Sources" "$SRC/Resources" "$DEST/"
cd "$DEST"
if [ "${1:-}" = "build" ]; then
  xtool dev build
else
  xtool dev
fi
