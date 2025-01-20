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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3333;

// Important: Serve the dist directory directly
app.use(express.static(__dirname));

// Simple health check
app.get("/api/health", (_, res) => {
  res.json({ status: "ok" });
});

// For any other route, send the index.html file
app.get("*", (_, res) => {
  // Important: Send the built index.html
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
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
  return {
    content: [
      {
        type: "text",
        text: `Here is the latest image from the WebCam.`,
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP-exfiltrate POC");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
