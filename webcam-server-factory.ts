import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerFactory } from "./transport/base-transport.js";

// Store clients with their resolve functions
export let clients = new Map<string, any>();
export let captureCallbacks = new Map<
  string,
  (response: string | { error: string }) => void
>();

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

function getPort(): number {
  return process.env.PORT ? parseInt(process.env.PORT) : 3333;
}

/**
 * Factory function to create and configure an MCP server instance with webcam capabilities
 */
export const createWebcamServer: ServerFactory = async () => {
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

  // Set up resource handlers
  mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async () => {
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

  mcpServer.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
};