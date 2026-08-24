#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.hn"

echo "Installing hn globally..."

cd "$SCRIPT_DIR"
npm install
npm run build

npm uninstall -g hn 2>/dev/null || true
npm link

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
    echo '{}' > "$CONFIG_DIR/config.json"
    echo "Created $CONFIG_DIR/config.json"
fi

echo ""
echo "Installation complete!"
echo ""
echo "  hn status                         # both APIs reachable?"
echo "  hn top --limit 10 --pretty        # front page"
echo "  hn search -q 'claude code' --since 30d --min-points 50"
echo "  hn skill install --all            # skill for Claude Code, Codex, pi"
echo "  hn --help"
echo ""
