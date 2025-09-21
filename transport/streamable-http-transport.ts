import { StatefulTransport, type TransportOptions, type BaseSession } from './base-transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';

interface StreamableHttpConnection extends BaseSession<StreamableHTTPServerTransport> {
  activeResponse?: Response;
}

type Session = StreamableHttpConnection;

export class StreamableHttpTransport extends StatefulTransport<Session> {

  initialize(_options: TransportOptions): Promise<void> {
    this.setupRoutes();
    this.startStaleConnectionCheck();
    this.startPingKeepAlive();

    Logger.info('StreamableHTTP transport initialized', {
      heartbeatInterval: this.HEARTBEAT_INTERVAL,
      staleCheckInterval: this.STALE_CHECK_INTERVAL,
      staleTimeout: this.STALE_TIMEOUT,
      pingEnabled: this.PING_ENABLED,
      pingInterval: this.PING_INTERVAL,
    });
    return Promise.resolve();
  }

  private setupRoutes(): void {
    if (!this.app) {
      throw new Error('Express app is required for StreamableHTTP transport');
    }

    // Initialize new session or handle existing session request
    this.app.post('/mcp', (req, res) => {
      void (async () => {
        await this.handleRequest(req, res, 'POST');
      })();
    });

    // SSE stream endpoint
    this.app.get('/mcp', (req, res) => {
      void (async () => {
        await this.handleRequest(req, res, 'GET');
      })();
    });

    // Session termination
    this.app.delete('/mcp', (req, res) => {
      void (async () => {
        await this.handleRequest(req, res, 'DELETE');
      })();
    });
  }

  private async handleRequest(req: Request, res: Response, method: string): Promise<void> {
    try {
      const sessionId = req.headers['mcp-session-id'] as string;

      // Update activity timestamp for existing sessions
      if (sessionId && this.sessions.has(sessionId)) {
        this.updateSessionActivity(sessionId);
      }

      switch (method) {
        case 'POST':
          await this.handlePostRequest(req, res, sessionId);
          break;
        case 'GET':
          await this.handleGetRequest(req, res, sessionId);
          break;
        case 'DELETE':
          await this.handleDeleteRequest(req, res, sessionId);
          break;
      }
    } catch (error) {
      Logger.error(`Request handling error for ${method}:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: req?.body?.id,
        });
      }
    }
  }

  private async handlePostRequest(req: Request, res: Response, sessionId?: string): Promise<void> {
    try {
      // Extract user parameter
      const user = (req.query.user as string) || 'default';

      // Reject new connections during shutdown
      if (!sessionId && this.isShuttingDown) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Server is shutting down",
          },
          id: req?.body?.id,
        });
        return;
      }

      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.sessions.has(sessionId)) {
        const existingSession = this.sessions.get(sessionId);
        if (!existingSession) {
          res.status(404).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Session not found: ${sessionId}`,
            },
            id: req?.body?.id,
          });
          return;
        }
        transport = existingSession.transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Create new session only for initialization requests
        transport = await this.createSession(user);
      } else if (!sessionId) {
        // No session ID and not an initialization request
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: 'Missing session ID for non-initialization request',
          },
          id: req?.body?.id,
        });
        return;
      } else {
        // Invalid session ID
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Session not found: ${sessionId}`,
          },
          id: req?.body?.id,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      throw error; // Re-throw to be handled by outer error handler
    }
  }

  private async handleGetRequest(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Session not found: ${sessionId || 'missing'}`,
        },
        id: null,
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Session not found: ${sessionId}`,
        },
        id: null,
      });
      return;
    }

    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      Logger.debug(`Client attempting to resume with Last-Event-ID for session ${sessionId}: ${lastEventId}`);
    }

    // Store the active response for heartbeat monitoring
    session.activeResponse = res;

    // Set up heartbeat to detect stale SSE connections
    this.startHeartbeat(sessionId, res);

    // Set up connection event handlers
    this.setupSseEventHandlers(sessionId, res);

    await session.transport.handleRequest(req, res);
  }

  private async handleDeleteRequest(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Session not found: ${sessionId || 'missing'}`,
        },
        id: req?.body?.id,
      });
      return;
    }

    Logger.info(`Session termination requested for ${sessionId}`);

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Session not found: ${sessionId}`,
        },
        id: req?.body?.id,
      });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
    await this.removeSession(sessionId);
  }

  private async createSession(user: string = 'default'): Promise<StreamableHTTPServerTransport> {
    // Create server instance using factory
    const server = await this.serverFactory(user);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        Logger.info(`Session initialized with ID: ${sessionId}`);

        // Create session object and store it immediately
        const session: Session = {
          transport,
          server,
          metadata: {
            id: sessionId,
            connectedAt: new Date(),
            lastActivity: new Date(),
            user: user,
            capabilities: {},
          },
        };

        this.sessions.set(sessionId, session);
      },
    });

    // Set up cleanup on transport close
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId && this.sessions.has(sessionId)) {
        Logger.info(`Transport closed for session ${sessionId}, cleaning up`);
        void this.removeSession(sessionId);
      }
    };

    // Set up error tracking for server errors
    server.server.onerror = (error) => {
      Logger.error(`StreamableHTTP server error for session ${transport.sessionId}:`, error);
    };

    // Set up client info capture when initialized
    server.server.oninitialized = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.createClientInfoCapture(sessionId)();
      }
    };

    // Connect to session-specific server
    await server.connect(transport);

    return transport;
  }

  private async removeSession(sessionId: string): Promise<void> {
    // Check if session exists to prevent duplicate cleanup
    if (!this.sessions.has(sessionId)) {
      return;
    }
    await this.cleanupSession(sessionId);
  }

  /**
   * Remove a stale session - implementation for StatefulTransport
   */
  protected async removeStaleSession(sessionId: string): Promise<void> {
    Logger.warn(`Removing stale session ${sessionId}`);
    await this.cleanupSession(sessionId);
  }

  async cleanup(): Promise<void> {
    // Stop stale checker using base class helper
    this.stopStaleConnectionCheck();

    // Use base class cleanup method
    await this.cleanupAllSessions();

    Logger.info('StreamableHTTP transport cleanup complete');
  }
}