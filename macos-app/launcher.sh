#!/bin/bash
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
CONFIG_DIR="$HOME/Library/Application Support/Eos OBS Bridge"

# First-run: create config directory and copy example config
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cp "$RESOURCES/config.example.json" "$CONFIG_DIR/config.json"
fi

# Open the config UI in the default browser once the server is ready
(sleep 1.5 && open "http://127.0.0.1:8082/") &

# Start the bridge — exec replaces this shell so the .app lifecycle = server lifecycle
exec "$RESOURCES/eos-obs-bridge"
