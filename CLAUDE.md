# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an OSC-to-WebSocket bridge application that receives lighting cue data from ETC Eos lighting consoles and forwards it to OBS Studio overlays via WebSocket.

**Fresh TypeScript Implementation**: The codebase is now fully TypeScript with a clean, modular architecture using the `eos-console` library for unified OSC and API communication over TCP port 3037.

- **Production**: `src/` directory (TypeScript, modular architecture)
- **Legacy**: `legacy/server.js` (JavaScript, archived for reference)

### Key Files
- **src/index.ts**: Application entry point with bootstrap logic
- **src/app.ts**: Main orchestrator (EosOverlayBridge class)
- **src/config.ts**: Configuration management
- **src/lib/eosConnection.ts**: Eos console connection wrapper with reconnection
- **src/lib/cueDataSync.ts**: Cue data caching and synchronization
- **src/lib/cueStateManager.ts**: Simplified cue state management
- **src/lib/oscParser.ts**: OSC message parsing utilities
- **src/lib/overlayServer.ts**: HTTP + WebSocket on one port (serves `overlay.html`, cue updates)
- **overlay.html**: Browser-based overlay for OBS Studio (load via `http://127.0.0.1:<WEBSOCKET_PORT>/` in OBS)

## Architecture

The application uses a clean, modular architecture with event-driven components:

### Core Components

**EosConnection** (src/lib/eosConnection.ts):
- Wraps `eos-console` library for unified OSC + API communication
- Connects to console on TCP port 3037
- Exponential backoff reconnection (1s, 2s, 5s, 10s, 30s delays)
- Forwards OSC messages and connection events

**CueDataSync** (src/lib/cueDataSync.ts):
- Three-tier caching strategy:
  - Initial full sync on connection
  - On-demand fetch for missing cues
  - Smart prefetch for anticipated cues
- 10-minute cache TTL
- Provides accurate fade times from console

**CueStateManager** (src/lib/cueStateManager.ts):
- Simplified state management (no XState dependency)
- Tracks cue lifecycle: DISCOVERED → ACTIVE → COMPLETING → BACKGROUND → FINISHED
- Validates state transitions
- Manages stale detection and auto-completion timers

**OverlayServer** (src/lib/overlayServer.ts):
- HTTP server on `websocket.port` (GET `/` and `/overlay.html` → `overlay.html` from repo root)
- WebSocket on the same TCP port for cue updates (OBS: avoid `file://`; use `http://127.0.0.1:PORT/`)
- Broadcasts cue updates to overlay clients; ping/pong heartbeat for connection health

**EosOverlayBridge** (src/app.ts):
- Main orchestrator coordinating all components
- Wires up event handlers
- Routes OSC messages to appropriate handlers
- Manages application lifecycle

### Message Processing
1. **OSC Input**: Processes messages from `/eos/out/active/cue/text`, `/eos/out/previous/cue/text`, and `/eos/out/event/cue/*/fire`
2. **Enhanced Cue Data**: Retrieves complete cue list from Eos console using `eos-console` library for accurate fade times, labels, and metadata
3. **Robust Parsing**: Handles active cue format `[LIST]/[NUMBER] [LABEL] [TIME] [PERCENTAGE]` and previous cue format `[LIST]/[NUMBER] [LABEL] [TIME]` with support for multiple time formats (decimal seconds, MM:SS, HH:MM:SS)
4. **Data Fusion**: Combines live OSC data with stored console data for optimal accuracy
5. **State Management**: Tracks cue transitions through defined lifecycle with validation (legacy: manual, modern: XState)
6. **WebSocket Broadcast**: Sends structured data to overlay clients with current and background cues

### State Machine
- **States**: DISCOVERED, ACTIVE, COMPLETING, BACKGROUND, FINISHED, TERMINATED, STALE, ERROR
- **Legacy**: Manual state transition validation in `CueTracker` class (server.js:201-629)
- **Modern**: XState-based state machine in `src/machines/simpleCueMachine.ts` with formal state definitions
- Manages multiple concurrent cues with proper state transitions
- Handles background cue completion estimation and cleanup
- Provides stale cue detection and automatic cleanup
- Maintains state history for debugging

## Common Commands

```bash
# Development
npm install                  # Install dependencies
npm start                    # Build and start production server
npm run dev                  # Start with auto-reload (uses ts-node)

# Building
npm run build                # Compile TypeScript to dist/

# Testing
npm test                     # Run all tests with Jest
npm run test:watch           # Run tests in watch mode
npm run test:coverage        # Generate test coverage report

# Legacy (for reference)
npm run legacy               # Run archived JavaScript implementation
```

## Configuration

### Environment Variables

```bash
# === Eos Console Connection ===
EOS_HOST=10.101.100.101             # Console IP address
EOS_PORT=3037                       # Port for OSC + API (default: 3037)
EOS_CONNECTION_TIMEOUT=10000        # Connection timeout in ms
EOS_RECONNECT_MAX_ATTEMPTS=0        # Max reconnect attempts (0 = infinite)

# === Cue Tracking ===
CUE_LIST=1                          # Which cue list to track
STALE_TIMEOUT=2000                  # Cue stale timeout in ms
COMPLETION_TIMEOUT=500              # Auto-finish timeout in ms

# === Data Synchronization ===
SYNC_ON_CONNECT=true                # Perform full sync on connection
SYNC_INTERVAL=300000                # Full sync interval in ms (5 min)
PREFETCH_ENABLED=true               # Enable smart prefetch
CACHE_TTL=600000                    # Cache TTL in ms (10 min)

# === Overlay (HTTP + WebSocket, same port) ===
WEBSOCKET_PORT=8081                 # HTTP page + WebSocket (OBS URL: http://127.0.0.1:8081/)
WEBSOCKET_PING_INTERVAL=30000       # Ping interval in ms

# === Logging ===
LOG_LEVEL=info                      # debug | info | warn | error
LOG_OSC=false                       # Log OSC messages (verbose)
LOG_STATE=true                      # Log state transitions
```

### Connection Architecture

**Unified TCP Connection** (Port 3037):
- Uses `eos-console` library for both OSC and API over single connection
- Requires "Third Party OSC" enabled in Eos Shell
- Requires "Allow Remotes" enabled in Setup > Remotes
- Eliminates port conflict between OSC and API
- See `TCP_OSC_SETUP.md` for Eos console setup instructions

**Benefits**:
- Accurate fade times from console cue list data
- Proactive cue information retrieval with smart prefetch
- Precise completion time estimates
- Automatic detection and fetching of missing cues
- Exponential backoff reconnection for stability

## Usage in OBS

Add a **Browser Source** with URL **`http://127.0.0.1:<WEBSOCKET_PORT>/`** (same port as `WEBSOCKET_PORT` / `config.websocket.port`). Do not rely on **Local file** → `overlay.html`: OBS’s CEF often blocks WebSocket from `file://`. The overlay displays:
- Main cue in large text with visual state indicators (running=green, completed=white, stale=red)
- Background running cues in smaller text below
- Flash animation for newly detected cues
- Special handling for instant cues (0-second duration)

## Code Architecture

### Key Classes and Functions

**EosConnection** (src/lib/eosConnection.ts):
- `connect()`: Establishes connection to console with timeout
- `disconnect()`: Gracefully closes connection
- `getCue()` / `getCues()`: Proxy methods for Eos API calls
- `handleDisconnect()`: Automatic reconnection with exponential backoff
- Events: `connected`, `disconnected`, `osc-message`, `error`, `reconnecting`

**CueDataSync** (src/lib/cueDataSync.ts):
- `initialSync()`: Fetches all cues from console on startup
- `ensureCueData()`: Returns cached data or fetches on-demand
- `prefetchNextCues()`: Smart prefetch for anticipated cues
- `createCacheEntry()`: Determines best fade time from available timing channels

**CueStateManager** (src/lib/cueStateManager.ts):
- `handleFire()`: Process cue fire events, transition active cues to background
- `handleActiveUpdate()`: Process active cue updates with percentage tracking
- `handlePreviousUpdate()`: Process background cue updates
- `transitionToState()`: Validates transitions using VALID_TRANSITIONS
- `resetStaleTimer()`: Manages stale detection for active cues

**OverlayServer** (src/lib/overlayServer.ts):
- Serves `overlay.html` over HTTP on the overlay port; WebSocket upgrades on the same server
- `broadcastCueUpdate()`: Send cue updates to all connected overlay clients
- `broadcastConnectionStatus()`: Inform overlays of console connection state
- `pingClients()`: Heartbeat for connection health

**EosOverlayBridge** (src/app.ts):
- `start()`: Initialize all components and establish console connection
- `stop()`: Graceful shutdown with cleanup
- `handleOSCMessage()`: Route incoming OSC messages to appropriate handlers
- Event-driven coordination between all components

### Error Handling
- Comprehensive OSC message validation (oscParser.ts)
- State transition validation using VALID_TRANSITIONS
- Automatic reconnection with exponential backoff
- Graceful handling of missing cues with on-demand fetch
- WebSocket reconnection logic in overlay
- Configuration validation on startup
- Process-level error handlers (uncaught exceptions, unhandled rejections)

### Debugging
- Structured logging with configurable levels (debug, info, warn, error)
- State transition logging via `enableStateLogging` config
- OSC message logging via `LOG_OSC` environment variable
- Event emission for all significant actions
- Status information via `getStatus()` method

## Testing

Jest is configured for testing TypeScript code in the `src/` directory:
- Test files: `src/**/__tests__/**/*.test.ts`
- Configuration: `jest.config.js` with `ts-jest` preset
- Setup: `jest.setup.js` for test environment configuration
- Run tests: `npm test` or `npm run test:watch`
- Coverage: `npm run test:coverage`

## Development Workflow

When working on this codebase:

1. **Development**: Use `npm run dev` for auto-reload with ts-node
2. **VS Code debugging**: Use "Run TypeScript Server" or "Debug TypeScript Server" launch configurations
3. **Production build**: `npm run build` compiles to `dist/`, then `npm start`
4. **New features**: Work in `src/` directory (TypeScript)
5. **Testing**: Add tests to `src/**/__tests__/` for new code
6. **Type safety**: All components use comprehensive TypeScript interfaces
7. **Event-driven**: Components communicate via EventEmitter with typed events
8. **Legacy reference**: Old implementation available at `legacy/server.js` for comparison