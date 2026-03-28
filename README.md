# Eos-to-OBS Overlay Bridge

Real-time lighting cue overlay for OBS Studio, synced with ETC Eos lighting consoles.

## Features

- **Live Cue Tracking**: Displays active and background cues in real-time
- **Accurate Fade Times**: Retrieves precise timing data from Eos console API
- **Smart Caching**: Three-tier caching strategy (initial sync + on-demand + prefetch)
- **Automatic Reconnection**: Exponential backoff with infinite retry attempts
- **State Management**: Tracks cue lifecycle through DISCOVERED → ACTIVE → COMPLETING → FINISHED
- **WebSocket Broadcast**: Real-time updates to OBS overlay clients

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

# WebSocket
WEBSOCKET_PORT=8081

# Logging
LOG_LEVEL=info
LOG_OSC=false
LOG_STATE=true
```

## OBS Setup

1. Add a **Browser Source** in OBS
2. Set **Local file** to: `/path/to/obs-eos-overlay/overlay.html`
3. Set dimensions (e.g., 1920x1080)
4. The overlay will automatically connect to `ws://localhost:8081`

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
- **src/lib/overlayServer.ts** - WebSocket server

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

**Overlay not updating:**
1. Check WebSocket connection in browser console
2. Verify `WEBSOCKET_PORT=8081`
3. Reload browser source in OBS

**Incorrect timing:**
1. Ensure the bridge can connect to the console on port `3037` for accurate fade times
2. Check console cue list has timing data
3. Watch for sync logs in console output

## License

ISC
