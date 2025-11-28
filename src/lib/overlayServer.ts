/**
 * OverlayServer
 * WebSocket server for broadcasting cue data to OBS overlay clients
 */

import { EventEmitter } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { CueData } from '../types/cue';
import { OverlayMessageType, OverlayMessage } from '../types/websocket';

interface Client {
  id: string;
  socket: WebSocket;
  connectedAt: number;
  lastPing?: number;
}

export class OverlayServer extends EventEmitter {
  private server: WebSocketServer | null = null;
  private clients: Map<string, Client> = new Map();
  private port: number;
  private pingInterval: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private nextClientId: number = 1;

  constructor(config: { port: number; pingInterval: number }) {
    super();
    this.port = config.port;
    this.pingInterval = config.pingInterval;
  }

  /**
   * Start WebSocket server
   */
  start(): void {
    if (this.server) {
      throw new Error('OverlayServer is already running');
    }

    console.log(`[OverlayServer] Starting WebSocket server on port ${this.port}...`);

    this.server = new WebSocketServer({ port: this.port });

    this.server.on('connection', (socket: WebSocket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (error: Error) => {
      console.error('[OverlayServer] Server error:', error);
      this.emit('error', error);
    });

    // Start ping interval
    this.startPingInterval();

    console.log(`[OverlayServer] WebSocket server started on port ${this.port}`);
    this.emit('started');
  }

  /**
   * Stop WebSocket server
   */
  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      this.server.close(() => {
        console.log('[OverlayServer] WebSocket server stopped');
        this.emit('stopped');
      });
      this.server = null;
    }
  }

  /**
   * Broadcast cue update to all connected clients
   */
  broadcastCueUpdate(activeCues: CueData[]): void {
    const latestCue = activeCues.length > 0 ? activeCues[0] : null;

    const message: OverlayMessage = {
      type: OverlayMessageType.CUE_UPDATE,
      timestamp: Date.now(),
      data: {
        activeCues,
        latestCue,
        totalTrackedCues: activeCues.length,
      },
    };

    this.broadcast(message);
  }

  /**
   * Broadcast connection status to all clients
   */
  broadcastConnectionStatus(oscConnected: boolean): void {
    const message: OverlayMessage = {
      type: OverlayMessageType.CONNECTION_STATUS,
      timestamp: Date.now(),
      data: {
        connected: oscConnected,
        clientCount: this.clients.size,
        oscConnected,
      },
    };

    this.broadcast(message);
  }

  /**
   * Broadcast error message to all clients
   */
  broadcastError(error: string, recoverable: boolean = true): void {
    const message: OverlayMessage = {
      type: OverlayMessageType.ERROR,
      timestamp: Date.now(),
      data: {
        error,
        recoverable,
      },
    };

    this.broadcast(message);
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client list
   */
  getClients(): Client[] {
    return Array.from(this.clients.values());
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stop();
    this.removeAllListeners();
  }

  // ===== PRIVATE METHODS =====

  /**
   * Handle new client connection
   */
  private handleConnection(socket: WebSocket): void {
    const clientId = `client-${this.nextClientId++}`;

    const client: Client = {
      id: clientId,
      socket,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);

    console.log(`[OverlayServer] Client connected: ${clientId} (total: ${this.clients.size})`);

    // Set up socket event handlers
    socket.on('message', (data: WebSocket.Data) => {
      this.handleMessage(client, data);
    });

    socket.on('close', () => {
      this.handleDisconnect(client);
    });

    socket.on('error', (error: Error) => {
      console.error(`[OverlayServer] Client ${clientId} error:`, error);
    });

    socket.on('pong', () => {
      client.lastPing = Date.now();
    });

    this.emit('client-connected', client);
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(client: Client): void {
    this.clients.delete(client.id);

    console.log(`[OverlayServer] Client disconnected: ${client.id} (remaining: ${this.clients.size})`);

    this.emit('client-disconnected', client);
  }

  /**
   * Handle message from client
   */
  private handleMessage(client: Client, data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[OverlayServer] Message from ${client.id}:`, message);
      this.emit('client-message', { client, message });
    } catch (error) {
      console.error(`[OverlayServer] Failed to parse message from ${client.id}:`, error);
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: OverlayMessage): void {
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    let failedCount = 0;

    for (const client of this.clients.values()) {
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(messageStr);
          sentCount++;
        }
      } catch (error) {
        console.error(`[OverlayServer] Failed to send to ${client.id}:`, error);
        failedCount++;
      }
    }

    if (sentCount > 0) {
      console.log(`[OverlayServer] Broadcasting ${message.type} to ${sentCount} client(s)`);
      this.emit('broadcast', { messageType: message.type, sentCount, failedCount });
    }
  }

  /**
   * Start ping interval
   */
  private startPingInterval(): void {
    if (this.pingTimer) {
      return; // Already started
    }

    this.pingTimer = setInterval(() => {
      this.pingClients();
    }, this.pingInterval);
  }

  /**
   * Ping all clients
   */
  private pingClients(): void {
    const staleClients: string[] = [];

    for (const client of this.clients.values()) {
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.ping();
        } else {
          // Client socket is not open, mark for removal
          staleClients.push(client.id);
        }
      } catch (error) {
        console.error(`[OverlayServer] Failed to ping ${client.id}:`, error);
        staleClients.push(client.id);
      }
    }

    // Remove stale clients
    for (const clientId of staleClients) {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.socket.close();
        } catch (err) {
          // Ignore
        }
        this.clients.delete(clientId);
        console.log(`[OverlayServer] Removed stale client: ${clientId}`);
      }
    }
  }
}
