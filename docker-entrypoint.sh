#!/bin/sh
# Prepares the private folders Maestro and the agents use, then starts the engine.
set -e
umask 077
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
chmod 700 "$HOME" "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# Optional Claude Code login mounted read-only at /run/claude-login (see docker-compose.yml):
# copied into the private config folder so the CLI can refresh its token there.
if [ -f /run/claude-login/.credentials.json ]; then
  cp /run/claude-login/.credentials.json "$CLAUDE_CONFIG_DIR/.credentials.json"
  chmod 600 "$CLAUDE_CONFIG_DIR/.credentials.json"
fi

umask 022
exec ./node_modules/.bin/tsx src/index.ts
