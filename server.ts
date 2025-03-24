#!/usr/bin/env node

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolSchema,
  SamplingMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** EXPRESS SERVER SETUP  */
let clients = new Map<string, express.Response>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function getPort(): number {
  const portArg = process.argv[2];
  if (portArg && !isNaN(Number(portArg))) {
    return Number(portArg);
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

async function main() {
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
    console.error('Server connected');
  } catch (error) {
    console.error('Failed to connect server:', error);
    handleShutdown('connection failed');
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});