#!/bin/bash
# Install qiaomu-music-player-spotify skill for Claude Code
set -e

SKILL_NAME="qiaomu-music-player-spotify"
SKILL_DIR="$HOME/.claude/skills/$SKILL_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "🎵 Installing $SKILL_NAME for Claude Code..."
echo ""

# Copy skill files
mkdir -p "$SKILL_DIR"

for file in SKILL.md spotify.py auth_setup.py .env.example; do
  if [ -f "$SCRIPT_DIR/$file" ]; then
    cp "$SCRIPT_DIR/$file" "$SKILL_DIR/$file"
    echo "  ✓ $file"
  fi
done

# Copy references directory
if [ -d "$SCRIPT_DIR/references" ]; then
  cp -r "$SCRIPT_DIR/references" "$SKILL_DIR/"
  echo "  ✓ references/ (5,947 music genres)"
fi

echo ""
echo "✅ Skill installed to: $SKILL_DIR"
echo ""
echo "Next steps:"
echo "  1. Set environment variables:"
echo "     export SPOTIFY_CLIENT_ID=\"your_client_id\""
echo "     export SPOTIFY_CLIENT_SECRET=\"your_client_secret\""
echo ""
echo "  2. Run OAuth authorization:"
echo "     python3 $SKILL_DIR/auth_setup.py"
echo ""
echo "  3. Restart Claude Code to activate the skill."
echo ""
echo "Get your Spotify credentials at: https://developer.spotify.com/dashboard"
