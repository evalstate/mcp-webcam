import { StatefulTransport, type TransportOptions, type BaseSession } from './base-transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

type StdioSession = BaseSession<StdioServerTransport>;

/**
 * Implementation of STDIO transport
 */
export class StdioTransport extends StatefulTransport<StdioSession> {
  private readonly SESSION_ID = 'STDIO';

  async initialize(_options: TransportOptions): Promise<void> {
    const transport = new StdioServerTransport();
    
    // Create server instance using factory
    const server = await this.serverFactory();

    // Create session with metadata tracking
    const session: StdioSession = {
      transport,
      server,
      metadata: {
        id: this.SESSION_ID,
        connectedAt: new Date(),
        lastActivity: new Date(),
        capabilities: {},
      },
    };

    // Store session in map
    this.sessions.set(this.SESSION_ID, session);

    try {
      // Set up request/response interceptors for activity tracking
      const originalSendMessage = transport.send.bind(transport);
      transport.send = (message) => {
        this.updateSessionActivity(this.SESSION_ID);
        return originalSendMessage(message);
      };

      // Set up oninitialized callback to capture client info using base class helper
      server.server.oninitialized = this.createClientInfoCapture(this.SESSION_ID);

      // Set up error tracking
      server.server.onerror = (error) => {
        console.error('STDIO server error:', error);
      };

      // Handle transport closure
      transport.onclose = () => {
        console.error('STDIO transport closed');
        void this.handleShutdown('transport closed');
      };

      await server.connect(transport);
      console.error('STDIO transport initialized');
    } catch (error) {
      console.error('Error connecting STDIO transport:', error);
      // Clean up on error
      this.sessions.delete(this.SESSION_ID);
      throw error;
    }
  }

  /**
   * STDIO doesn't need stale session removal since there's only one persistent session
   */
  protected removeStaleSession(sessionId: string): Promise<void> {
    // STDIO has only one session and it's not subject to staleness
    console.error(`STDIO session staleness check for ${sessionId} (no-op)`);
    return Promise.resolve();
  }

  async cleanup(): Promise<void> {
    const session = this.sessions.get(this.SESSION_ID);
    if (session) {
      try {
        await session.transport.close();
      } catch (error) {
        console.error('Error closing STDIO transport:', error);
      }
      try {
        await session.server.close();
      } catch (error) {
        console.error('Error closing STDIO server:', error);
      }
    }
    this.sessions.clear();
    console.error('STDIO transport cleaned up');
  }

  /**
   * Get the STDIO session if it exists
   */
  getSession(): StdioSession | undefined {
    return this.sessions.get(this.SESSION_ID);
  }

  /**
   * Handle shutdown for STDIO
   */
  private async handleShutdown(reason: string): Promise<void> {
    console.error(`Initiating shutdown (reason: ${reason})`);
    
    try {
      await this.cleanup();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }

  /**
   * Set up stdin/stdout event handlers
   */
  setupStdioHandlers(): void {
    // Handle stdin/stdout events
    process.stdin.on('end', () => this.handleShutdown('stdin ended'));
    process.stdin.on('close', () => this.handleShutdown('stdin closed'));
    process.stdout.on('error', () => this.handleShutdown('stdout error'));
    process.stdout.on('close', () => this.handleShutdown('stdout closed'));
  }
}