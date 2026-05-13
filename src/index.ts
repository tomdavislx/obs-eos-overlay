/**
 * Entry Point for Eos-to-OBS Overlay Bridge
 * Bootstraps the application with configuration, error handling, and graceful shutdown
 */

import { config as initialConfig, loadConfig, printConfigSummary, type Config } from './config';
import { EosOverlayBridge } from './app';
import { ConfigServer } from './lib/configServer';

// Global reference to application instance
let app: EosOverlayBridge | null = null;
let currentConfig = initialConfig;
let isShuttingDown = false;
let isRestarting = false;
/** When Apply is clicked during an in-flight restart, run another restart after the current one finishes. */
let restartPending = false;

/**
 * Main application entry point
 */
async function main() {
  try {
    console.log('\n' + '='.repeat(60));
    console.log('  ETC Eos-to-OBS Overlay Bridge');
    console.log('  Fresh TypeScript Implementation');
    console.log('='.repeat(60) + '\n');

    // Print configuration summary
    printConfigSummary(currentConfig);

    // Start config UI server (stays alive across bridge restarts)
    if (currentConfig.configUI.enabled) {
      const configServer = new ConfigServer({
        port: currentConfig.configUI.port,
        getStatus: () => (app ? { ...app.getStatus(), running: app.isRunning() } : { running: false }),
        // Always reflect config.json + env merge so the UI matches disk right after Apply.
        getConfig: (): Config => {
          try {
            return loadConfig();
          } catch {
            return currentConfig;
          }
        },
      });
      configServer.on('restart', () => restartBridge());
      configServer.on('shutdown', () => shutdown('config-ui'));
      configServer.start();
    }

    // Start bridge
    await startBridge();

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('  FATAL ERROR - Application failed to start');
    console.error('='.repeat(60));
    console.error(error);
    process.exit(1);
  }
}

async function startBridge(): Promise<void> {
  app = new EosOverlayBridge(currentConfig);
  setupEventHandlers(app);
  await app.start();

  console.log('\n' + '='.repeat(60));
  console.log('  Application running successfully');
  console.log('  Press Ctrl+C to stop');
  console.log('='.repeat(60) + '\n');
}

async function restartBridge(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  if (isRestarting) {
    restartPending = true;
    return;
  }

  isRestarting = true;

  try {
    let first = true;
    // Inner try/catch so a thrown stop/start does not skip a pending follow-up restart.
    while (first || restartPending) {
      first = false;
      restartPending = false;
      try {
        console.log('\n[Main] Restarting bridge with new configuration...');

        if (app) {
          await app.stop();
          app = null;
        }

        currentConfig = loadConfig();
        printConfigSummary(currentConfig);
        await startBridge();
        console.log('[Main] Bridge restarted successfully');
      } catch (error) {
        console.error('[Main] Bridge restart failed:', error);
        if (!restartPending) {
          break;
        }
      }
    }
  } finally {
    isRestarting = false;
  }
}

/**
 * Set up application event handlers
 */
function setupEventHandlers(app: EosOverlayBridge): void {
  // Application events
  app.on('started', () => {
    console.log('[Main] Application started');
  });

  app.on('stopped', () => {
    console.log('[Main] Application stopped');
  });

  app.on('console-connected', () => {
    console.log('[Main] Console connected');
  });

  app.on('console-disconnected', () => {
    console.warn('[Main] Console disconnected - will attempt to reconnect');
  });

  app.on('console-error', (error: any) => {
    console.error('[Main] Console error:', error.message);
  });

  app.on('error', (error: any) => {
    console.error('[Main] Application error:', error);
  });
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[Main] Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;

  console.log(`\n[Main] Received ${signal}, shutting down gracefully...`);

  try {
    isRestarting = true; // prevent concurrent restart
    if (app) {
      await app.stop();
      app = null;
    }

    console.log('[Main] Shutdown complete');
    process.exit(0);

  } catch (error) {
    console.error('[Main] Error during shutdown:', error);
    process.exit(1);
  }
}

/**
 * Unhandled error handlers
 */
function setupProcessHandlers(): void {
  // Graceful shutdown signals
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Unhandled errors
  process.on('uncaughtException', (error: Error) => {
    console.error('\n' + '='.repeat(60));
    console.error('  UNCAUGHT EXCEPTION');
    console.error('='.repeat(60));
    console.error(error);
    console.error('\n[Main] Attempting emergency shutdown...');

    try {
      if (app) {
        void app.stop();
      }
    } catch (shutdownError) {
      console.error('[Main] Error during emergency shutdown:', shutdownError);
    }

    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('\n' + '='.repeat(60));
    console.error('  UNHANDLED PROMISE REJECTION');
    console.error('='.repeat(60));
    console.error('Reason:', reason);
    console.error('Promise:', promise);

    // Don't exit on unhandled rejection, just log it
    // This allows reconnection logic to continue working
  });
}

// ===== BOOTSTRAP =====

// Set up process handlers
setupProcessHandlers();

// Start application
main().catch((error) => {
  console.error('\n' + '='.repeat(60));
  console.error('  FATAL ERROR');
  console.error('='.repeat(60));
  console.error(error);
  process.exit(1);
});
