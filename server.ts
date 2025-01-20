import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
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
let captureCallbacks = new Map<string, (image: string) => void>();

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
    name: "mcp-capture",
    version: "0.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "capture",
        description: "Gets the latest picture from the webcam.",
        inputSchema: { type: "object", parameters: {} } as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {

  if(0 === clients.size){
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Have you opened your web browser?. Please go to http://localhost:${getPort()}, enable your Webcam and try again.`,
        },
      ],
    }
  }

  const clientId = Array.from(clients.keys())[0];

  if (!clientId) {
    throw new Error("No clients connected");
  }

  // Create a promise that will resolve with the image
  const imageData = await new Promise<string>((resolve) => {
    // Store the resolve function
    console.error(`Capturing for ${clientId}`);
    captureCallbacks.set(clientId, resolve);

    // Tell the client to capture using the write method on the Response object
    clients
      .get(clientId)
      ?.write(`data: ${JSON.stringify({ type: "capture" })}\n\n`);
  });

  const { mimeType, base64Data } = parseDataUrl(imageData);

  return {
    content: [
      {
        type: "text",
        text: `Here is the latest image from the WebCam.`,
      },
      {
        type: "image",
        data: base64Data,
        mimeType: mimeType
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
    throw new Error('Invalid data URL format');
  }
  return {
    mimeType: matches[1],
    base64Data: matches[2]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
