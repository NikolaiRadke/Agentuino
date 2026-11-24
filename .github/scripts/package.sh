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
# version.json is only for the update check, not part of the release zip
rm -f "$DIST/$NAME/version.json"
(cd "$DIST" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$DIST/$NAME"

# Marketplace / Open VSX build: made with vsce, ArduDebug comes along as pack member
# (can be removed on its own). Not for the Arduino IDE, which has no Marketplace.
MARKET="$DIST/market"
cp -r "$ROOT/agentuino/extension" "$MARKET"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$MARKET/"
node -e "const f='$MARKET/package.json';const p=require(f);p.extensionPack=['NikolaiRadke.ardudebug'];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')"
(cd "$MARKET" && npx --yes @vscode/vsce package --no-dependencies -o "$DIST/$NAME-marketplace.vsix")
rm -rf "$MARKET"

# The update check reads this file, so only a release announces a new version
printf '{\n  "version": "%s"\n}\n' "$VERSION" > "$ROOT/installer/version.json"

echo "Built $DIST/$NAME.vsix, $DIST/$NAME-marketplace.vsix and $DIST/$NAME.zip"
