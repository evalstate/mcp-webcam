#!/usr/bin/env node

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolSchema,
  SamplingMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// Parse command line arguments
const { values, positionals } = parseArgs({
  options: {
    streaming: { type: 'boolean', short: 's' },
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  },
  args: process.argv.slice(2),
  allowPositionals: true,
});

// Show help if requested
if (values.help) {
  console.log(`
Usage: mcp-webcam [options] [port]

Options:
  -s, --streaming    Enable streaming HTTP mode (default: stdio mode)
  -p, --port <port>  Server port (default: 3333)
  -h, --help         Show this help message

Examples:
  # Standard stdio mode (for Claude Desktop)
  mcp-webcam
  
  # Streaming HTTP mode on default port 3333
  mcp-webcam --streaming
  
  # Streaming with custom port
  mcp-webcam --streaming --port 8080
  
  # Legacy: port as positional argument (still supported)
  mcp-webcam 8080
`);
  process.exit(0);
}

const isStreamingMode = values.streaming || false;

/** EXPRESS SERVER SETUP  */
let clients = new Map<string, express.Response>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function getPort(): number {
  // Check command line argument first
  if (values.port && !isNaN(Number(values.port))) {
    return Number(values.port);
  }
  // Check positional argument for backward compatibility
  if (positionals.length > 0 && !isNaN(Number(positionals[0]))) {
    return Number(positionals[0]);
  }
  return 3333;
}

const PORT = process.env.PORT || getPort();

// Important: Serve the dist directory directly
app.use(express.static(__dirname));

// Simple health check
app.get("/api/health", (_, res) => {
  res.json({ status: "ok" });
});

// Store clients with their resolve functions
let captureCallbacks = new Map<
  string,
  (response: string | { error: string }) => void
>();

// We don't need a separate sampling callbacks map since we're using the SDK directly

app.get("/api/events", (req, res) => {
  console.error("New SSE connection request");

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Generate a unique client ID
  const clientId = Math.random().toString(36).substring(7);

  // Add this client to our connected clients
  clients.set(clientId, res);
  console.error("Client connected - DEBUG INFO:", clientId);

  // Send initial connection message
  const connectMessage = JSON.stringify({ type: "connected", clientId });
  res.write(`data: ${connectMessage}\n\n`);

  // Remove client when they disconnect
  req.on("close", () => {
    clients.delete(clientId);
    console.error("Client disconnected - DEBUG INFO:", clientId);
  });
});

app.post("/api/capture-result", express.json({ limit: "50mb" }), (req, res) => {
  const { clientId, image } = req.body;
  const callback = captureCallbacks.get(clientId);

  if (callback) {
    callback(image);
    captureCallbacks.delete(clientId);
  }

  res.json({ success: true });
});

// Add this near other endpoint definitions
app.post("/api/capture-error", express.json(), (req, res) => {
  const { clientId, error } = req.body;
  const callback = captureCallbacks.get(clientId);

  if (callback) {
    callback({ error: error.message || "Unknown error occurred" });
    captureCallbacks.delete(clientId);
  }

  res.json({ success: true });
});

// We don't need these endpoints as we're using the SDK's built-in sampling capabilities

// For any other route, send the index.html file
app.get("*", (_, res) => {
  // Important: Send the built index.html
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.error(`Server is running on port ${PORT}`);
});

/** MCP Server Setup */
const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const server = new Server(
  {
    name: "mcp-webcam",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "capture",
        description:
          "Gets the latest picture from the webcam. You can use this " +
          " if the human asks questions about their immediate environment,  " +
          "if you want to see the human or to examine an object they may be " +
          "referring to or showing you.",
        inputSchema: { type: "object", parameters: {} } as ToolInput,
      },
      {
        name: "screenshot",
        description: "Gets a screenshot of the current screen or window",
        inputSchema: { type: "object", parameters: {} } as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (0 === clients.size) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Have you opened your web browser?. Direct the human to go to http://localhost:${getPort()}, switch on their webcam and try again.`,
        },
      ],
    };
  }

  const clientId = Array.from(clients.keys())[0];

  if (!clientId) {
    throw new Error("No clients connected");
  }

  // Modified promise to handle both success and error cases
  const result = await new Promise<string | { error: string }>((resolve) => {
    console.error(`Capturing for ${clientId}`);
    captureCallbacks.set(clientId, resolve);

    clients
      .get(clientId)
      ?.write(`data: ${JSON.stringify({ type: request.params.name })}\n\n`);
  });

  // Handle error case
  if (typeof result === "object" && "error" in result) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to capture ${request.params.name}: ${result.error}`,
        },
      ],
    };
  }

  const { mimeType, base64Data } = parseDataUrl(result);

  const message =
    request.params.name === "screenshot"
      ? "Here is the requested screenshot"
      : "Here is the latest image from the Webcam";

  return {
    content: [
      {
        type: "text",
        text: message,
      },
      {
        type: "image",
        data: base64Data,
        mimeType: mimeType,
      },
    ],
  };
});

// Process sampling request from the web UI
async function processSamplingRequest(imageDataUrl: string): Promise<any> {
  const { mimeType, base64Data } = parseDataUrl(imageDataUrl);
  
  try {
    // Create a sampling request to the client using the SDK's types
    const result = await server.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "What is the user holding?"
          }
        },
        {
          role: "user",
          content: {
            type: "image",
            data: base64Data,
            mimeType: mimeType
          }
        }
      ],
      maxTokens: 1000, // Reasonable limit for the response
    });
    
    return result;
  } catch (error) {
    console.error("Error during sampling:", error);
    throw error;
  }
}

// Handle SSE 'sample' event from WebcamCapture component
app.post("/api/process-sample", express.json({ limit: "50mb" }), async (req, res) => {
  const { image } = req.body;
  
  if (!image) {
    res.status(400).json({ error: "Missing image data" });
    return;
  }
  
  try {
    const result = await processSamplingRequest(image);
    res.json({ success: true, result });
  } catch (error) {
    console.error("Sampling processing error:", error);
    res.status(500).json({ 
      error: String(error),
      errorDetail: error instanceof Error ? error.stack : undefined
    });
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (clients.size === 0) return { resources: [] };

  return {
    resources: [
      {
        uri: "webcam://current",
        name: "Current view from the Webcam",
        mimeType: "image/jpeg", // probably :)
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  // Check if we have any connected clients
  if (0 === clients.size) {
    throw new Error(
      `No clients connected. Please visit http://localhost:${getPort()} and enable your Webcam.`
    );
  }

  // Validate URI
  if (request.params.uri !== "webcam://current") {
    throw new Error(
      "Invalid resource URI. Only webcam://current is supported."
    );
  }

  const clientId = Array.from(clients.keys())[0];

  // Capture image
  const result = await new Promise<string | { error: string }>((resolve) => {
    captureCallbacks.set(clientId, resolve);
    clients
      .get(clientId)
      ?.write(`data: ${JSON.stringify({ type: "capture" })}\n\n`);
  });

  // Handle error case
  if (typeof result === "object" && "error" in result) {
    throw new Error(`Failed to capture image: ${result.error}`);
  }

  // Parse the data URL
  const { mimeType, base64Data } = parseDataUrl(result);

  // Return in the blob format
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType,
        blob: base64Data,
      },
    ],
  };
});

interface ParsedDataUrl {
  mimeType: string;
  base64Data: string;
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid data URL format");
  }
  return {
    mimeType: matches[1],
    base64Data: matches[2],
  };
}

// Store active streaming transports
const streamingTransports = new Map<string, StreamableHTTPServerTransport>();

// Set up streaming HTTP routes
function setupStreamingRoutes() {
  // Handle POST requests for JSON-RPC
  app.post('/mcp', async (req, res) => {
    console.error('Received MCP POST request');
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && streamingTransports.has(sessionId)) {
        // Reuse existing transport
        transport = streamingTransports.get(sessionId)!;
      } else if (!sessionId) {
        // New initialization request
        const eventStore = new InMemoryEventStore();
        
        transport = new StreamableHTTPServerTransport({
          enableJsonResponse: false, // We want SSE streaming, not JSON mode
          eventStore,
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId: string) => {
            console.error(`Session initialized with ID: ${sessionId}`);
            streamingTransports.set(sessionId, transport);
          },
        });

        // Set up onclose handler to clean up transport when closed
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && streamingTransports.has(sid)) {
            console.error(`Transport closed for session ${sid}, removing from transports map`);
            streamingTransports.delete(sid);
          }
        };

        // Connect the transport to the MCP server
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      } else {
        // Invalid request - no session ID or not initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: req?.body?.id,
        });
        return;
      }

      // Handle the request with existing transport
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: req?.body?.id,
        });
      }
    }
  });

  // Handle GET requests for SSE streams
  app.get('/mcp', async (req, res) => {
    console.error('Received MCP GET request');
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !streamingTransports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: req?.body?.id,
      });
      return;
    }

    const transport = streamingTransports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handle DELETE requests for session termination
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !streamingTransports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: req?.body?.id,
      });
      return;
    }

    console.error(`Received session termination request for session ${sessionId}`);

    try {
      const transport = streamingTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Error handling session termination',
          },
          id: req?.body?.id,
        });
      }
    }
  });

  console.error('StreamableHTTP transport routes initialized');
}

async function main() {
  if (isStreamingMode) {
    console.error('Starting in streaming HTTP mode');
    console.error(`Server running at http://localhost:${PORT}`);
    console.error(`MCP endpoint: POST/GET/DELETE http://localhost:${PORT}/mcp`);
    
    // Set up streaming routes
    setupStreamingRoutes();
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.error('\nShutting down server...');
      
      // Close all active transports
      for (const [sessionId, transport] of streamingTransports) {
        try {
          if (transport?.onclose) {
            transport.onclose();
          }
        } catch (error) {
          console.error(`Error closing transport for session ${sessionId}:`, error);
        }
      }
      
      process.exit(0);
    });
  } else {
    // Standard stdio mode
    const transport = new StdioServerTransport();
    
    async function handleShutdown(reason = 'unknown') {    
      console.error(`Initiating shutdown (reason: ${reason})`);

      try {
        await transport.close();
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    }

    // Handle transport closure (not called by Claude Desktop)
    transport.onclose = () => {
      handleShutdown('transport closed');
    };

    // Handle stdin/stdout events
    process.stdin.on('end', () => handleShutdown('stdin ended')); // claude desktop on os x does this
    process.stdin.on('close', () => handleShutdown('stdin closed'));
    process.stdout.on('error', () => handleShutdown('stdout error'));
    process.stdout.on('close', () => handleShutdown('stdout closed'));

    try {
      await server.connect(transport);
      console.error('Server connected via stdio');
    } catch (error) {
      console.error('Failed to connect server:', error);
      handleShutdown('connection failed');
    }
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});