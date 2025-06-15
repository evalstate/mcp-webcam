#!/usr/bin/env node

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "node:util";
import { TransportFactory, type TransportType } from "./transport/transport-factory.js";
import { StdioTransport } from "./transport/stdio-transport.js";
import { StreamableHttpTransport } from "./transport/streamable-http-transport.js";
import { createWebcamServer, clients, captureCallbacks } from "./webcam-server-factory.js";
import type { BaseTransport } from "./transport/base-transport.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

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
let transport: BaseTransport;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Add JSON parsing middleware for MCP requests with large payload support
app.use(express.json({ limit: "50mb" }));

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

const PORT = process.env.PORT ? parseInt(process.env.PORT) : getPort();

// Important: Serve the dist directory directly
app.use(express.static(__dirname));

// Simple health check
app.get("/api/health", (_, res) => {
  res.json({ status: "ok" });
});

// Get active sessions
app.get("/api/sessions", (_, res) => {
  if (!transport) {
    res.json({ sessions: [] });
    return;
  }
  
  const sessions = transport.getSessions().map((session) => {
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

// Note: captureCallbacks is now imported from webcam-server-factory.ts

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

app.post("/api/capture-result", (req, res) => {
  const { clientId, image } = req.body;
  const callback = captureCallbacks.get(clientId);

  if (callback) {
    callback(image);
    captureCallbacks.delete(clientId);
  }

  res.json({ success: true });
});

// Add this near other endpoint definitions
app.post("/api/capture-error", (req, res) => {
  const { clientId, error } = req.body;
  const callback = captureCallbacks.get(clientId);

  if (callback) {
    callback({ error: error.message || "Unknown error occurred" });
    captureCallbacks.delete(clientId);
  }

  res.json({ success: true });
});

// Process sampling request from the web UI
async function processSamplingRequest(
  imageDataUrl: string,
  prompt: string = "What is the user holding?",
  sessionId?: string
): Promise<any> {
  const { mimeType, base64Data } = parseDataUrl(imageDataUrl);

  try {
    let server: any;

    // Get the appropriate server instance based on transport mode
    if (isStreamingMode && sessionId) {
      // In streaming mode, need to find the server for the specific session
      const streamingTransport = transport as StreamableHttpTransport;
      const sessions = streamingTransport.getSessions();
      const targetSession = sessions.find(s => s.id === sessionId);
      if (!targetSession) {
        throw new Error("No active MCP session found for sampling");
      }
      
      // For now, use the main server - in production you'd access the session-specific server
      server = (transport as any).sessions?.get(sessionId)?.server?.server;
      if (!server) {
        throw new Error("No server instance found for session");
      }
    } else if (!isStreamingMode) {
      // In stdio mode, use the main server
      const stdioTransport = transport as StdioTransport;
      const session = stdioTransport.getSession();
      if (!session) {
        throw new Error("No STDIO session found");
      }
      server = session.server.server;
    } else {
      throw new Error("Invalid sampling request configuration");
    }

    // Check if server has sampling capability
    if (!server.createMessage) {
      throw new Error(
        "Server does not support sampling - no MCP client with sampling capabilities connected"
      );
    }

    // Create a sampling request to the client using the SDK's types
    const result: CreateMessageResult = await server.createMessage({
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
  async (req, res) => {
    const { image, prompt, sessionId } = req.body;

    if (!image) {
      res.status(400).json({ error: "Missing image data" });
      return;
    }

    try {
      // In streaming mode, use provided sessionId or fall back to first available
      let selectedSessionId: string | undefined = sessionId;
      if (isStreamingMode && transport) {
        const sessions = transport.getSessions();
        if (!selectedSessionId || !sessions.find(s => s.id === selectedSessionId)) {
          // Fall back to the most recently connected session
          const sortedSessions = sessions.sort(
            (a, b) => b.connectedAt.getTime() - a.connectedAt.getTime()
          );
          selectedSessionId = sortedSessions[0]?.id;
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

async function main() {
  if (isStreamingMode) {
    console.error("Starting in streaming HTTP mode");

    // Create streaming transport
    transport = TransportFactory.create('streamable-http', createWebcamServer, app);

    // Initialize transport
    await transport.initialize({ port: Number(PORT) });

    // IMPORTANT: Define the wildcard route AFTER all other routes
    // This catches any other route and sends the index.html file
    app.get("*", (_, res) => {
      // Important: Send the built index.html
      res.sendFile(path.join(__dirname, "index.html"));
    });

    // Now start the Express server
    app.listen(PORT, () => {
      console.error(`Server running at http://localhost:${PORT}`);
      console.error(
        `MCP endpoint: POST/GET/DELETE http://localhost:${PORT}/mcp`
      );
    });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.error("\nShutting down server...");
      
      if (transport) {
        transport.shutdown?.();
        await transport.cleanup();
      }

      process.exit(0);
    });
  } else {
    // Standard stdio mode
    console.error("Starting in STDIO mode");

    // Start the Express server for the web UI even in stdio mode
    app.listen(PORT, () => {
      console.error(`Web UI running at http://localhost:${PORT}`);
    });

    // Create and initialize STDIO transport
    transport = TransportFactory.create('stdio', createWebcamServer);
    await transport.initialize({});

    // Set up stdin/stdout event handlers for STDIO transport
    if (transport instanceof StdioTransport) {
      transport.setupStdioHandlers();
    }

    console.error("Server connected via stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});