# Eos-to-OBS Overlay Bridge

Real-time lighting cue overlay for OBS Studio, synced with ETC Eos lighting consoles.

## Features

- **Live Cue Tracking**: Displays active and background cues in real-time
- **Accurate Fade Times**: Retrieves precise timing data from Eos console API
- **Smart Caching**: Three-tier caching strategy (initial sync + on-demand + prefetch)
- **Automatic Reconnection**: Exponential backoff with infinite retry attempts
- **State Management**: Tracks cue lifecycle through DISCOVERED → ACTIVE → COMPLETING → FINISHED
- **Overlay HTTP + WebSocket**: Serves `overlay.html` and cue updates on one port (reliable in OBS’s browser)

## Quick Start

### Prerequisites

- Node.js 16+
- ETC Eos console with "Third Party OSC" enabled
- OBS Studio

### Installation

```bash
npm install
```

### Testing Connection

Before running the application, test your Eos console connection:

```bash
# Test basic TCP connectivity
npm run test:tcp

# Test full Eos Console API
npm run test:connection
```

### Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### Configuration

Set environment variables or create a `.env` file:

```bash
# Eos Console
EOS_HOST=10.101.100.101
EOS_PORT=3037

# Cue Tracking
CUE_LIST=1
STALE_TIMEOUT=2000
COMPLETION_TIMEOUT=500

# Data Sync
SYNC_ON_CONNECT=true
SYNC_INTERVAL=300000
PREFETCH_ENABLED=true
CACHE_TTL=600000

# Overlay (HTTP page + WebSocket on same port)
WEBSOCKET_PORT=8081

# Logging
LOG_LEVEL=info
LOG_OSC=false
LOG_STATE=true
```

## OBS Setup

1. Start the bridge (`npm run dev` or `npm start`).
2. Add a **Browser Source** in OBS.
3. Set the URL to **`http://127.0.0.1:8081/`** (use your `WEBSOCKET_PORT` if you changed it).  
   **Do not use “Local file”** for the overlay: OBS’s embedded browser often blocks WebSocket from `file://`, while a normal desktop browser still works with a local file.
4. If the bridge runs on another computer, use **`http://<bridge-machine-LAN-IP>:8081/`** instead.
5. Set dimensions (e.g. 1920×1080).

The page and WebSocket share the same host and port, so no extra query parameters are needed unless you intentionally override them (`?bridgeHost=` / `?bridgePort=`).

## Eos Console Setup

### Required Settings

1. **Enable Third Party OSC**:
   - Press `[Displays]` key
   - Select "Shell" tab
   - Enable "Third Party OSC"

2. **Enable Allow Remotes**:
   - `[Setup]` → System Settings → System → Show Control
   - Check "Allow Remotes" checkbox

### Verification

Run the connection test to verify setup:
```bash
npm run test:connection
```

You should see:
- ✅ Connection successful
- Console version displayed
- Cues retrieved from list 1

## Development

```bash
# Run with TypeScript auto-reload
npm run dev

# Build for production
npm run build

# Run compiled version
npm start

# Run legacy JavaScript version
npm run legacy
```

### VS Code Debugging

Use the built-in launch configurations:
- **Run TypeScript Server** - Quick start with ts-node
- **Debug TypeScript Server** - With breakpoints
- **Run Compiled Server** - Test production build

## Architecture

- **src/index.ts** - Entry point with graceful shutdown
- **src/app.ts** - Main orchestrator (EosOverlayBridge)
- **src/config.ts** - Configuration management
- **src/lib/eosConnection.ts** - Eos console connection with reconnection
- **src/lib/cueDataSync.ts** - Cue data caching and synchronization
- **src/lib/cueStateManager.ts** - Cue lifecycle state management
- **src/lib/oscParser.ts** - OSC message parsing
- **src/lib/overlayServer.ts** - HTTP server for `overlay.html` + WebSocket cue broadcast (same port)

## Troubleshooting

### Connection Issues

**Timeout errors:**
1. Verify Eos console IP address
2. Check "Third Party OSC" is enabled
3. Check "Allow Remotes" is enabled
4. Test with: `npm run test:tcp`

**No cue data:**
1. Verify the bridge can connect to the console on port `3037`
2. Check cue list number is correct
3. Run: `npm run test:connection`

**OSC messages not received:**
1. Check console is sending OSC to correct IP/port
2. Enable OSC logging: `LOG_OSC=true`
3. Verify firewall allows port 3037

### Overlay Issues

**Overlay not updating or stuck “waiting for bridge WebSocket”:**
1. Use **`http://127.0.0.1:<WEBSOCKET_PORT>/`** in the Browser Source, not a path to `overlay.html` on disk.
2. Confirm the bridge log shows the overlay URL and `[OverlayServer] Client connected`.
3. Open the same URL in Chrome/Safari on that machine; if it works there but not in OBS, the URL is correct and the issue is OBS-specific cache or source settings—refresh the Browser Source.
4. From another PC, the URL must be the **bridge machine’s** IP, not `127.0.0.1` on the OBS machine.

**Incorrect timing:**
1. Ensure the bridge can connect to the console on port `3037` for accurate fade times
2. Check console cue list has timing data
3. Watch for sync logs in console output

## License

ISC
