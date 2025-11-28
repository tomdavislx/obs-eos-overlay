/**
 * Entry Point for Eos-to-OBS Overlay Bridge
 * Bootstraps the application with configuration, error handling, and graceful shutdown
 */

import { config, printConfigSummary } from './config';
import { EosOverlayBridge } from './app';

// Global reference to application instance
let app: EosOverlayBridge | null = null;
let isShuttingDown = false;

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
    printConfigSummary(config);

    // Create application instance
    app = new EosOverlayBridge(config);

    // Set up event handlers
    setupEventHandlers(app);

    // Start application
    await app.start();

    console.log('\n' + '='.repeat(60));
    console.log('  Application running successfully');
    console.log('  Press Ctrl+C to stop');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('  FATAL ERROR - Application failed to start');
    console.error('='.repeat(60));
    console.error(error);
    process.exit(1);
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
    if (app && app.isRunning()) {
      app.stop();
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
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Unhandled errors
  process.on('uncaughtException', (error: Error) => {
    console.error('\n' + '='.repeat(60));
    console.error('  UNCAUGHT EXCEPTION');
    console.error('='.repeat(60));
    console.error(error);
    console.error('\n[Main] Attempting emergency shutdown...');

    try {
      if (app) {
        app.stop();
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
