import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Express } from 'express';

/**
 * Factory function to create server instances
 * This should be provided during transport construction to enable per-connection server instances
 */
export type ServerFactory = () => Promise<McpServer>;

export interface TransportOptions {
  port?: number;
}

/**
 * Standardized session metadata structure for all transports
 */
export interface SessionMetadata {
  id: string;
  connectedAt: Date;
  lastActivity: Date;
  clientInfo?: {
    name: string;
    version: string;
  };
  capabilities: {
    sampling?: boolean;
    roots?: boolean;
  };
  pingFailures?: number;
  lastPingAttempt?: Date;
}

/**
 * Base session interface that all transport sessions should extend
 * This provides common fields while allowing transport-specific extensions
 */
export interface BaseSession<T = unknown> {
  transport: T;
  server: McpServer;
  metadata: SessionMetadata;
  heartbeatInterval?: NodeJS.Timeout;
}

/**
 * Base class for all transport implementations
 */
export abstract class BaseTransport {
  protected serverFactory: ServerFactory;
  protected app?: Express;

  constructor(serverFactory: ServerFactory, app?: Express) {
    this.serverFactory = serverFactory;
    this.app = app;
  }

  /**
   * Initialize the transport with the given options
   */
  abstract initialize(options: TransportOptions): Promise<void>;

  /**
   * Clean up the transport resources
   */
  abstract cleanup(): Promise<void>;

  /**
   * Mark transport as shutting down
   * Optional method for transports that need to reject new connections
   */
  shutdown?(): void;

  /**
   * Get the number of active connections
   */
  abstract getActiveConnectionCount(): number;

  /**
   * Get all active sessions with their metadata
   * Returns an array of session metadata for connection dashboard
   */
  getSessions(): SessionMetadata[] {
    return [];
  }
}

/**
 * Base class for stateful transport implementations that maintain session state
 * Provides common functionality for session management, stale connection detection, and client info tracking
 */
export abstract class StatefulTransport<TSession extends BaseSession = BaseSession> extends BaseTransport {
  protected sessions: Map<string, TSession> = new Map();
  protected isShuttingDown = false;
  protected staleCheckInterval?: NodeJS.Timeout;
  protected pingInterval?: NodeJS.Timeout;
  protected pingsInFlight = new Set<string>();

  // Configuration from environment variables with defaults
  protected readonly STALE_CHECK_INTERVAL = parseInt(process.env.MCP_CLIENT_CONNECTION_CHECK || '20000', 10);
  protected readonly STALE_TIMEOUT = parseInt(process.env.MCP_CLIENT_CONNECTION_TIMEOUT || '50000', 10);
  protected readonly HEARTBEAT_INTERVAL = parseInt(process.env.MCP_CLIENT_HEARTBEAT_INTERVAL || '30000', 10);
  protected readonly PING_ENABLED = process.env.MCP_PING_ENABLED !== 'false';
  protected readonly PING_INTERVAL = parseInt(process.env.MCP_PING_INTERVAL || '30000', 10);
  protected readonly PING_FAILURE_THRESHOLD = parseInt(process.env.MCP_PING_FAILURE_THRESHOLD || '1', 10);

  /**
   * Update the last activity timestamp for a session
   */
  protected updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata.lastActivity = new Date();
    }
  }

  /**
   * Check if a session is distressed (has excessive ping failures)
   */
  protected isSessionDistressed(session: BaseSession): boolean {
    return (session.metadata.pingFailures || 0) >= this.PING_FAILURE_THRESHOLD;
  }

  /**
   * Create a standardized client info capture callback for a session
   */
  protected createClientInfoCapture(sessionId: string): () => void {
    return () => {
      const session = this.sessions.get(sessionId);
      if (session) {
        const clientInfo = session.server.server.getClientVersion();
        const clientCapabilities = session.server.server.getClientCapabilities();

        if (clientInfo) {
          session.metadata.clientInfo = clientInfo;
        }

        if (clientCapabilities) {
          session.metadata.capabilities = {
            sampling: !!clientCapabilities.sampling,
            roots: !!clientCapabilities.roots,
          };
        }

        console.error(
          `Client Initialization Request for session ${sessionId}:`,
          {
            clientInfo: session.metadata.clientInfo,
            capabilities: session.metadata.capabilities,
          }
        );
      }
    };
  }

  /**
   * Send a fire-and-forget ping to a single session
   * Success updates lastActivity, failures increment failure count
   */
  protected pingSingleSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Skip if ping already in progress for this session
    if (this.pingsInFlight.has(sessionId)) {
      return;
    }

    // Mark ping as in-flight and update last ping attempt
    this.pingsInFlight.add(sessionId);
    session.metadata.lastPingAttempt = new Date();

    // Fire ping and handle result asynchronously
    session.server.server
      .ping()
      .then(() => {
        // SUCCESS: Update lastActivity timestamp and reset ping failures
        // This prevents the stale checker from removing this session
        this.updateSessionActivity(sessionId);
        session.metadata.pingFailures = 0;
        console.error(`Ping succeeded for session ${sessionId}`);
      })
      .catch((error: unknown) => {
        // FAILURE: Increment ping failure count
        session.metadata.pingFailures = (session.metadata.pingFailures || 0) + 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Ping failed for session ${sessionId}:`, errorMessage, `(failures: ${session.metadata.pingFailures})`);
      })
      .finally(() => {
        // Always remove from tracking set
        this.pingsInFlight.delete(sessionId);
      });
  }

  /**
   * Start the ping keep-alive interval
   */
  protected startPingKeepAlive(): void {
    if (!this.PING_ENABLED) {
      console.error('Ping keep-alive disabled');
      return;
    }

    this.pingInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      // Ping all sessions that don't have an active ping
      for (const sessionId of this.sessions.keys()) {
        this.pingSingleSession(sessionId);
      }
    }, this.PING_INTERVAL);

    console.error(`Started ping keep-alive with interval ${this.PING_INTERVAL}ms`);
  }

  /**
   * Stop the ping keep-alive interval
   */
  protected stopPingKeepAlive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
      // Clear any in-flight pings
      this.pingsInFlight.clear();
      console.error('Stopped ping keep-alive');
    }
  }

  /**
   * Start the stale connection check interval
   */
  protected startStaleConnectionCheck(): void {
    this.staleCheckInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      const now = Date.now();
      const staleSessionIds: string[] = [];

      // Find stale sessions
      for (const [sessionId, session] of this.sessions) {
        const timeSinceActivity = now - session.metadata.lastActivity.getTime();
        if (timeSinceActivity > this.STALE_TIMEOUT) {
          staleSessionIds.push(sessionId);
        }
      }

      // Remove stale sessions
      for (const sessionId of staleSessionIds) {
        const session = this.sessions.get(sessionId);
        if (session) {
          console.error(
            `Removing stale session ${sessionId} (inactive for ${Math.round((now - session.metadata.lastActivity.getTime()) / 1000)}s)`
          );
          void this.removeStaleSession(sessionId);
        }
      }
    }, this.STALE_CHECK_INTERVAL);

    console.error(`Started stale connection checker with ${this.STALE_CHECK_INTERVAL}ms interval, ${this.STALE_TIMEOUT}ms timeout`);
  }

  /**
   * Remove a stale session - must be implemented by concrete transport
   */
  protected abstract removeStaleSession(sessionId: string): Promise<void>;

  /**
   * Mark transport as shutting down
   */
  override shutdown(): void {
    this.isShuttingDown = true;
  }

  /**
   * Get the number of active connections
   */
  override getActiveConnectionCount(): number {
    return this.sessions.size;
  }

  /**
   * Check if server is accepting new connections
   */
  isAcceptingConnections(): boolean {
    return !this.isShuttingDown;
  }

  /**
   * Stop the stale connection check interval during cleanup
   */
  protected stopStaleConnectionCheck(): void {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = undefined;
    }
    this.stopPingKeepAlive();
  }

  /**
   * Get all active sessions with their metadata
   */
  override getSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values()).map((session) => session.metadata);
  }

  /**
   * Start heartbeat monitoring for a session with SSE response
   * Automatically detects stale connections and cleans them up
   */
  protected startHeartbeat(sessionId: string, response: { destroyed: boolean; writableEnded: boolean }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clear any existing heartbeat
    this.stopHeartbeat(sessionId);

    session.heartbeatInterval = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        console.error(`Detected stale connection via heartbeat for session ${sessionId}`);
        void this.removeStaleSession(sessionId);
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat monitoring for a session
   */
  protected stopHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
      session.heartbeatInterval = undefined;
    }
  }

  /**
   * Set up standard SSE connection event handlers
   */
  protected setupSseEventHandlers(
    sessionId: string,
    response: { on: (event: string, handler: (...args: unknown[]) => void) => void }
  ): void {
    response.on('close', () => {
      console.error(`SSE connection closed by client for session ${sessionId}`);
      void this.removeStaleSession(sessionId);
    });

    response.on('error', (...args: unknown[]) => {
      const error = args[0] as Error;
      console.error(`SSE connection error for session ${sessionId}:`, error);
      void this.removeStaleSession(sessionId);
    });
  }

  /**
   * Standard session cleanup implementation
   * Handles stopping heartbeat, closing transport/server
   */
  protected async cleanupSession(sessionId: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      console.error(`Cleaning up session ${sessionId}`);

      // Clear heartbeat interval
      this.stopHeartbeat(sessionId);

      // Close transport
      try {
        await (session.transport as { close(): Promise<void> }).close();
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }

      // Close server
      try {
        await session.server.close();
      } catch (error) {
        console.error(`Error closing server for session ${sessionId}:`, error);
      }

      // Remove from map
      this.sessions.delete(sessionId);

      console.error(`Session ${sessionId} cleaned up`);
    } catch (error) {
      console.error(`Error during session cleanup for ${sessionId}:`, error);
    }
  }

  /**
   * Clean up all sessions in parallel
   */
  protected async cleanupAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());

    const cleanupPromises = sessionIds.map((sessionId) =>
      this.cleanupSession(sessionId).catch((error: unknown) => {
        console.error(`Error during session cleanup for ${sessionId}:`, error);
      })
    );

    await Promise.allSettled(cleanupPromises);
    this.sessions.clear();
  }

  /**
   * Set up standard server configuration for a session
   * Configures client info capture and error tracking
   */
  protected setupServerForSession(server: McpServer, sessionId: string): void {
    // Set up client info capture
    server.server.oninitialized = this.createClientInfoCapture(sessionId);

    // Set up error tracking for server errors
    server.server.onerror = (error) => {
      console.error(`Server error for session ${sessionId}:`, error);
    };
  }
}