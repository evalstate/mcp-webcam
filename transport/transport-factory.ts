import { BaseTransport } from './base-transport.js';
import { StdioTransport } from './stdio-transport.js';
import { StreamableHttpTransport } from './streamable-http-transport.js';
import type { ServerFactory } from './base-transport.js';
import type { Express } from 'express';

export type TransportType = 'stdio' | 'streamable-http';

/**
 * Factory for creating transport instances
 */
export class TransportFactory {
  static create(
    type: TransportType,
    serverFactory: ServerFactory,
    app?: Express
  ): BaseTransport {
    switch (type) {
      case 'stdio':
        return new StdioTransport(serverFactory);
      case 'streamable-http':
        if (!app) {
          throw new Error('Express app is required for StreamableHTTP transport');
        }
        return new StreamableHttpTransport(serverFactory, app);
      default:
        throw new Error(`Unknown transport type: ${type}`);
    }
  }
}