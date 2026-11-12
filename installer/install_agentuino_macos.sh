#!/bin/bash
# Agentuino Extension Installer (adapted from AI.duino)

# Configuration
EXTENSIONS_DIR="$HOME/.arduinoIDE/extensions"
DEPLOYED_DIR="$HOME/.arduinoIDE/deployedPlugins"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${BLUE}Agentuino Extension Installer${NC}"
echo "================================"
echo

# Find VSIX file (versioned or not), newest version first
VSIX_FILE=""
if [ -f "$SCRIPT_DIR/agentuino.vsix" ]; then
    VSIX_FILE="$SCRIPT_DIR/agentuino.vsix"
else
    VSIX_FILE=$(ls "$SCRIPT_DIR"/agentuino-*.vsix 2>/dev/null | sort -V | tail -n 1)
fi

if [ -z "$VSIX_FILE" ] || [ ! -f "$VSIX_FILE" ]; then
    echo -e "${RED}Error: No agentuino*.vsix file found${NC}"
    echo "Looking for: agentuino.vsix or agentuino-*.vsix next to this script"
    exit 1
fi

VSIX_FILENAME=$(basename "$VSIX_FILE")
echo "Found: $VSIX_FILENAME"
echo

# Create extensions directory
if [ ! -d "$EXTENSIONS_DIR" ]; then
    echo "Creating extensions directory..."
    mkdir -p "$EXTENSIONS_DIR"
fi

# Remove old versions, the IDE would otherwise keep the old unpacked copy
echo "Cleaning up old installations..."
rm -f "$EXTENSIONS_DIR"/agentuino*.vsix 2>/dev/null
if ls "$DEPLOYED_DIR"/agentuino* 1> /dev/null 2>&1; then
    echo -e "${YELLOW}Removing old deployed extension(s)...${NC}"
    rm -rf "$DEPLOYED_DIR"/agentuino*
fi

# Copy new VSIX
echo "Installing Agentuino extension..."
if cp "$VSIX_FILE" "$EXTENSIONS_DIR/"; then
    echo -e "${GREEN}✓ Extension installed successfully!${NC}"
    echo
    echo "File: $VSIX_FILENAME"
    echo "Location: $EXTENSIONS_DIR/"
    echo
    echo "Restart the Arduino IDE to use Agentuino."
    echo "Your agentuino project folders in the sketches are not touched."
else
    echo -e "${RED}✗ Installation failed${NC}"
    exit 1
fi

echo
read -p "Press Enter to continue..."
