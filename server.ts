#!/usr/bin/env node

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  CreateMessageResult,
  InitializeRequestSchema,
  ToolAnnotationsSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// Parse command line arguments
const { values, positionals } = parseArgs({
  options: {
    streaming: { type: "boolean", short: "s" },
    port: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
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

// Get active sessions
app.get("/api/sessions", (_, res) => {
  const sessions = Array.from(sessionMetadata.values()).map((session) => {
    const now = Date.now();
    const lastActivityMs = session.lastActivity.getTime();
    const timeSinceActivity = now - lastActivityMs;
    
    // Consider stale after 50 seconds, but with 5 second grace period for ping responses
    // This prevents the red->green flicker when stale checker is about to run
    const isStale = timeSinceActivity > 50000; 
    
    // If we're in the "about to be pinged" window (45-50 seconds), 
    // preemptively mark as stale to avoid flicker
    const isPotentiallyStale = timeSinceActivity > 45000;
    
    return {
      id: session.id,
      connectedAt: session.connectedAt.toISOString(),
      capabilities: session.capabilities,
      clientInfo: session.clientInfo,
      isStale: isStale || isPotentiallyStale,
      lastActivity: session.lastActivity.toISOString(),
    };
  });
  res.json({ sessions });
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

// Don't start listening yet - we'll do it after setting up routes

/** MCP Server Setup */

// Function to set up additional server handlers that can't be done through McpServer methods
function setupServerHandlers(mcpServer: McpServer) {
  const server = mcpServer.server;

  // Capture client info during initialization
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    // Try to find the transport and session ID for this server
    const transport = serverToTransport.get(server);
    if (transport && transport.sessionId) {
      const metadata = sessionMetadata.get(transport.sessionId);
      if (metadata) {
        // Update last activity
        metadata.lastActivity = new Date();
        
        // Capture client info if provided
        if (request.params.clientInfo) {
          metadata.clientInfo = {
            name: request.params.clientInfo.name,
            version: request.params.clientInfo.version,
          };
        }
        
        // Update capabilities based on what the CLIENT supports
        if (request.params.capabilities) {
          // Client supports sampling if the sampling property exists
          metadata.capabilities.sampling = !!request.params.capabilities.sampling;
          console.error(
            `Client capabilities for session ${transport.sessionId}:`,
            { 
              sampling: metadata.capabilities.sampling,
              roots: !!request.params.capabilities.roots
            }
          );
        }
        
        sessionMetadata.set(transport.sessionId, metadata);
        console.error(
          `Updated session info for ${transport.sessionId}:`,
          { clientInfo: metadata.clientInfo, capabilities: metadata.capabilities }
        );
      }
    }

    // Return server info
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        sampling: {},
      },
      serverInfo: {
        name: "mcp-webcam",
        version: "0.1.0",
      },
    };
  });

  // Set up resource handlers
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
}

// Function to create and configure an MCP server instance
function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: "mcp-webcam",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        sampling: {}, // Enable sampling capability
      },
    }
  );

  // Set up handlers
  setupServerHandlers(mcpServer);

  // Define tools using the modern McpServer tool method
  mcpServer.tool(
    "capture",
    "Gets the latest picture from the webcam. You can use this " +
      " if the human asks questions about their immediate environment,  " +
      "if you want to see the human or to examine an object they may be " +
      "referring to or showing you.",
    {},
    {
      openWorldHint: true,
      readOnlyHint: true,
      title: "Take a Picture from the webcam",
    },
    async () => {
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
      const result = await new Promise<string | { error: string }>(
        (resolve) => {
          console.error(`Capturing for ${clientId}`);
          captureCallbacks.set(clientId, resolve);

          clients
            .get(clientId)
            ?.write(`data: ${JSON.stringify({ type: "capture" })}\n\n`);
        }
      );

      // Handle error case
      if (typeof result === "object" && "error" in result) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to capture: ${result.error}`,
            },
          ],
        };
      }

      const { mimeType, base64Data } = parseDataUrl(result);

      return {
        content: [
          {
            type: "text",
            text: "Here is the latest image from the Webcam",
          },
          {
            type: "image",
            data: base64Data,
            mimeType: mimeType,
          },
        ],
      };
    }
  );

  mcpServer.tool(
    "screenshot",
    "Gets a screenshot of the current screen or window",
    {},
    {
      openWorldHint: true,
      readOnlyHint: true,
      title: "Take a Screenshot",
    },
    async () => {
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
      const result = await new Promise<string | { error: string }>(
        (resolve) => {
          console.error(`Taking screenshot for ${clientId}`);
          captureCallbacks.set(clientId, resolve);

          clients
            .get(clientId)
            ?.write(`data: ${JSON.stringify({ type: "screenshot" })}\n\n`);
        }
      );

      // Handle error case
      if (typeof result === "object" && "error" in result) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to capture screenshot: ${result.error}`,
            },
          ],
        };
      }

      const { mimeType, base64Data } = parseDataUrl(result);

      return {
        content: [
          {
            type: "text",
            text: "Here is the requested screenshot",
          },
          {
            type: "image",
            data: base64Data,
            mimeType: mimeType,
          },
        ],
      };
    }
  );

  return mcpServer;
}

// Create the main server instance for stdio mode
const server = createMcpServer();

// Process sampling request from the web UI
async function processSamplingRequest(
  imageDataUrl: string,
  prompt: string = "What is the user holding?",
  sessionId?: string
): Promise<any> {
  const { mimeType, base64Data } = parseDataUrl(imageDataUrl);

  try {
    let samplingServer: Server;

    // In streaming mode, use the transport-specific server
    if (isStreamingMode && sessionId) {
      const transport = streamingTransports.get(sessionId);
      if (!transport) {
        throw new Error("No active MCP session found for sampling");
      }

      const transportMcpServer = transportServers.get(sessionId);
      if (!transportMcpServer) {
        throw new Error("No server instance found for session");
      }

      samplingServer = transportMcpServer.server;
    } else {
      // In stdio mode, use the main server
      samplingServer = server.server;
    }

    // Check if server has sampling capability
    if (!samplingServer.createMessage) {
      throw new Error(
        "Server does not support sampling - no MCP client with sampling capabilities connected"
      );
    }

    // Create a sampling request to the client using the SDK's types
    // Send text and image as separate messages since the SDK doesn't support content arrays
    const result: CreateMessageResult = await samplingServer.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: prompt,
          },
        },
        {
          role: "user",
          content: {
            type: "image",
            data: base64Data,
            mimeType: mimeType,
          },
        },
      ],
      maxTokens: 1000, // Reasonable limit for the response
    });
    console.error("GOT A RESPONSE " + JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error("Error during sampling:", error);
    throw error;
  }
}

// Handle SSE 'sample' event from WebcamCapture component
app.post(
  "/api/process-sample",
  express.json({ limit: "50mb" }),
  async (req, res) => {
    const { image, prompt, sessionId } = req.body;

    if (!image) {
      res.status(400).json({ error: "Missing image data" });
      return;
    }

    try {
      // In streaming mode, use provided sessionId or fall back to first available
      let selectedSessionId: string | undefined = sessionId;
      if (isStreamingMode && streamingTransports.size > 0) {
        if (!selectedSessionId || !streamingTransports.has(selectedSessionId)) {
          // Fall back to the most recently connected session
          const sessions = Array.from(sessionMetadata.values()).sort(
            (a, b) => b.connectedAt.getTime() - a.connectedAt.getTime()
          );
          selectedSessionId = sessions[0]?.id;
        }
        console.error(`Using session ${selectedSessionId} for sampling`);
      }

      const result = await processSamplingRequest(
        image,
        prompt,
        selectedSessionId
      );
      res.json({ success: true, result });
    } catch (error) {
      console.error("Sampling processing error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        errorDetail: error instanceof Error ? error.stack : undefined,
      });
    }
  }
);

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

// Store transports with their associated server instances for sampling
const transportServers = new Map<string, McpServer>();

// Map to track server to transport mapping for client info capture
const serverToTransport = new WeakMap<Server, StreamableHTTPServerTransport>();

// Store session metadata
interface SessionMetadata {
  id: string;
  connectedAt: Date;
  lastActivity: Date;
  capabilities: {
    sampling: boolean;
    tools: boolean;
    resources: boolean;
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

const sessionMetadata = new Map<string, SessionMetadata>();

// Set up streaming HTTP routes
function setupStreamingRoutes() {
  console.error("Setting up MCP routes...");

  // Handle POST requests for JSON-RPC
  app.post("/mcp", async (req, res) => {
    console.error("Received MCP POST request");
    console.error("Headers:", req.headers);
    console.error("Body:", req.body);
    try {
      // Check for existing session ID
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      
      // Update last activity for existing sessions
      if (sessionId && sessionMetadata.has(sessionId)) {
        const metadata = sessionMetadata.get(sessionId)!;
        metadata.lastActivity = new Date();
        sessionMetadata.set(sessionId, metadata);
      }
      let transport: StreamableHTTPServerTransport;

      if (sessionId && streamingTransports.has(sessionId)) {
        // Reuse existing transport
        transport = streamingTransports.get(sessionId)!;
      } else if (!sessionId) {
        // New initialization request
        const eventStore = new InMemoryEventStore();

        // Create a new server instance for this transport connection
        const transportServer = createMcpServer();

        transport = new StreamableHTTPServerTransport({
          enableJsonResponse: false, // We want SSE streaming, not JSON mode
          eventStore,
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId: string) => {
            console.error(`Session initialized with ID: ${sessionId}`);
            streamingTransports.set(sessionId, transport);
            // Store session metadata
            sessionMetadata.set(sessionId, {
              id: sessionId,
              connectedAt: new Date(),
              lastActivity: new Date(),
              capabilities: {
                sampling: false, // Will be updated when client sends capabilities
                tools: true,
                resources: true,
              },
            });
            // Store the server instance when the session is initialized
            transportServers.set(sessionId, transportServer);
            console.error(`Stored transport server for session ${sessionId}`);
          },
        });

        // Track server to transport mapping after transport is created
        serverToTransport.set(transportServer.server, transport);
        transport.onerror;
        // TODO -- diagnose why this handler doesn't run
        transport.onclose = () => {
          console.error("IN THE ONCLOSE HANDLER");
          const sessionId = transport.sessionId;
          if (sessionId && streamingTransports.has(sessionId)) {
            console.error(
              `Transport closed for session ${sessionId}, removing from transports map`
            );
            streamingTransports.delete(sessionId);
            transportServers.delete(sessionId);
            const delmeta = sessionMetadata.delete(sessionId);
            console.error(`delete session ${delmeta} for ${sessionId}`);
          }
        };

        // Connect the transport to its dedicated server
        await transportServer.connect(transport);

        await transport.handleRequest(req, res);
        return;
      } else {
        // Invalid request - no session ID or not initialization request
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: req?.body?.id,
        });
        return;
      }

      // Handle the request with existing transport
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
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
  });

  // Handle GET requests for SSE streams
  app.get("/mcp", async (req, res) => {
    console.error("Received MCP GET request");
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !streamingTransports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: req?.body?.id,
      });
      return;
    }

    const transport = streamingTransports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handle DELETE requests for session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !streamingTransports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: req?.body?.id,
      });
      return;
    }

    console.error(
      `Received session termination request for session ${sessionId}`
    );

    try {
      const transport = streamingTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
      await transport.close();

      streamingTransports.delete(sessionId);
      transportServers.delete(sessionId);
      sessionMetadata.delete(sessionId);
    } catch (error) {
      console.error("Error handling session termination:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Error handling session termination",
          },
          id: req?.body?.id,
        });
      }
    }
  });

  // IMPORTANT: Define the wildcard route AFTER all other routes
  // This catches any other route and sends the index.html file
  app.get("*", (_, res) => {
    // Important: Send the built index.html
    res.sendFile(path.join(__dirname, "index.html"));
  });

  console.error("StreamableHTTP transport routes initialized");
}

// Periodic cleanup of stale connections
// The stale checker runs every 20 seconds and pings connections that haven't
// had activity in 50+ seconds. If they respond, they become active again.
// To prevent visual flicker (red->green), the /api/sessions endpoint marks
// connections as stale at 45 seconds, giving a 5-second buffer.
let staleCheckInterval: NodeJS.Timeout | null = null;

async function sendPingToSession(sessionId: string): Promise<boolean> {
  try {
    const transportServer = transportServers.get(sessionId);
    if (!transportServer) {
      return false;
    }
    
    // Use the built-in ping method
    await transportServer.server.ping();
    
    return true;
  } catch (error) {
    console.error(`Ping failed for session ${sessionId}:`, error);
    return false;
  }
}

function startStaleConnectionCheck() {
  console.error("Starting stale connection checker with 20s interval");
  staleCheckInterval = setInterval(async () => {
    const now = Date.now();
    const staleTimeout = 50000; // 50 seconds
    const sessionsToRemove: string[] = [];
    
    console.error(`Checking ${sessionMetadata.size} sessions for staleness`);
    
    for (const [sessionId, metadata] of sessionMetadata) {
      const timeSinceActivity = now - metadata.lastActivity.getTime();
      console.error(`Session ${sessionId}: last activity ${Math.round(timeSinceActivity / 1000)}s ago`);
      // First check if connection is potentially stale based on last activity
      if (now - metadata.lastActivity.getTime() > staleTimeout) {
        console.error(`Session ${sessionId} appears stale, sending ping...`);
        
        // Try to ping the client
        const pingSuccess = await sendPingToSession(sessionId);
        
        if (pingSuccess) {
          // Client responded to ping, update last activity
          metadata.lastActivity = new Date();
          sessionMetadata.set(sessionId, metadata);
          console.error(`Session ${sessionId} responded to ping, keeping alive`);
        } else {
          // Ping failed, mark for removal
          console.error(`Session ${sessionId} did not respond to ping, marking for removal`);
          sessionsToRemove.push(sessionId);
        }
      }
    }
    
    // Remove stale sessions
    for (const sessionId of sessionsToRemove) {
      console.error(`Removing stale session ${sessionId}`);
      
      // Clean up transport and server
      const transport = streamingTransports.get(sessionId);
      if (transport) {
        try {
          transport.close();
        } catch (error) {
          console.error(`Error closing stale transport ${sessionId}:`, error);
        }
      }
      
      // Remove from all maps
      streamingTransports.delete(sessionId);
      transportServers.delete(sessionId);
      sessionMetadata.delete(sessionId);
    }
  }, 20000); // Check every 20 seconds
}

async function main() {
  if (isStreamingMode) {
    console.error("Starting in streaming HTTP mode");

    // Set up streaming routes BEFORE starting the server
    setupStreamingRoutes();

    // Now start the Express server
    app.listen(PORT, () => {
      console.error(`Server running at http://localhost:${PORT}`);
      console.error(
        `MCP endpoint: POST/GET/DELETE http://localhost:${PORT}/mcp`
      );
    });
    
    // Start stale connection checker
    startStaleConnectionCheck();

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.error("\nShutting down server...");
      
      // Stop stale check interval
      if (staleCheckInterval) {
        clearInterval(staleCheckInterval);
      }

      // Close all active transports and their servers
      for (const [sessionId, transport] of streamingTransports) {
        try {
          if (transport?.onclose) {
            transport.onclose();
          }
        } catch (error) {
          console.error(
            `Error closing transport for session ${sessionId}:`,
            error
          );
        }
      }

      // Clear the server map
      transportServers.clear();

      process.exit(0);
    });
  } else {
    // Standard stdio mode

    // Start the Express server for the web UI even in stdio mode
    app.listen(PORT, () => {
      console.error(`Web UI running at http://localhost:${PORT}`);
    });

    const transport = new StdioServerTransport();

    async function handleShutdown(reason = "unknown") {
      console.error(`Initiating shutdown (reason: ${reason})`);

      try {
        await transport.close();
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    }

    // Handle transport closure (not called by Claude Desktop)
    transport.onclose = () => {
      handleShutdown("transport closed");
    };

    // Handle stdin/stdout events
    process.stdin.on("end", () => handleShutdown("stdin ended")); // claude desktop on os x does this
    process.stdin.on("close", () => handleShutdown("stdin closed"));
    process.stdout.on("error", () => handleShutdown("stdout error"));
    process.stdout.on("close", () => handleShutdown("stdout closed"));

    try {
      await server.connect(transport);
      console.error("Server connected via stdio");
    } catch (error) {
      console.error("Failed to connect server:", error);
      handleShutdown("connection failed");
    }
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
