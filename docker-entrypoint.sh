#!/bin/sh
# Prepares the private folders Maestro and the agents use, then starts the engine.
set -e
umask 077
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
chmod 700 "$HOME" "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

umask 022
exec ./node_modules/.bin/tsx src/index.ts
