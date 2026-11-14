#!/bin/sh
# Agentuino: build the VSIX and the release zip (installer + VSIX) into dist/
# and put the VSIX next to the installers in installer/ (the installers need it)
# Usage: sh .github/scripts/package.sh
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=$(node -p "require('$ROOT/agentuino/extension/package.json').version")
MANIFEST=$(sed -n 's/.*Identity[^>]*Version="\([^"]*\)".*/\1/p' "$ROOT/agentuino/extension.vsixmanifest")

# Both version numbers must match, otherwise the IDE shows the wrong one
if [ "$VERSION" != "$MANIFEST" ]; then
    echo "Version mismatch: package.json $VERSION, extension.vsixmanifest $MANIFEST" >&2
    exit 1
fi

DIST="$ROOT/dist"
NAME="agentuino-$VERSION"
rm -rf "$DIST"
mkdir -p "$DIST/$NAME"

(cd "$ROOT/agentuino" && zip -qr "$DIST/$NAME.vsix" '[Content_Types].xml' extension.vsixmanifest extension)
rm -f "$ROOT"/installer/agentuino-*.vsix
cp "$DIST/$NAME.vsix" "$ROOT/installer/"
cp "$ROOT"/installer/* "$DIST/$NAME/"
(cd "$DIST" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$DIST/$NAME"

echo "Built $DIST/$NAME.vsix and $DIST/$NAME.zip"
