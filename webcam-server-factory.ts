import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerFactory } from "./transport/base-transport.js";

// Store clients with their resolve functions, grouped by user
export let clients = new Map<string, Map<string, any>>(); // user -> clientId -> response
export let captureCallbacks = new Map<
  string,
  Map<string, (response: string | { error: string }) => void>
>(); // user -> clientId -> callback

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
  // Check command line argument first (from process.argv)
  const args = process.argv.slice(2);
  const portArgIndex = args.findIndex(arg => arg === '-p' || arg === '--port');
  if (portArgIndex !== -1 && portArgIndex + 1 < args.length) {
    const portValue = parseInt(args[portArgIndex + 1]);
    if (!isNaN(portValue)) {
      return portValue;
    }
  }
  
  // Check positional argument for backward compatibility
  const lastArg = args[args.length - 1];
  if (lastArg && !lastArg.startsWith('-') && !isNaN(Number(lastArg))) {
    return Number(lastArg);
  }
  
  // Check environment variable
  if (process.env.PORT) {
    return parseInt(process.env.PORT);
  }
  
  return 3333;
}

function getMcpHost(): string {
  return process.env.MCP_HOST || `http://localhost:${getPort()}`;
}

// Helper functions for user-scoped client management
export function getUserClients(user: string): Map<string, any> {
  if (!clients.has(user)) {
    clients.set(user, new Map());
  }
  return clients.get(user)!;
}

export function getUserCallbacks(user: string): Map<string, (response: string | { error: string }) => void> {
  if (!captureCallbacks.has(user)) {
    captureCallbacks.set(user, new Map());
  }
  return captureCallbacks.get(user)!;
}

/**
 * Factory function to create and configure an MCP server instance with webcam capabilities
 */
export const createWebcamServer: ServerFactory = async (user: string = 'default') => {
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
    const userClients = getUserClients(user);
    if (userClients.size === 0) return { resources: [] };

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
    // Check if we have any connected clients for this user
    const userClients = getUserClients(user);
    if (userClients.size === 0) {
      throw new Error(
        `No clients connected for user '${user}'. Please visit ${getMcpHost()}${user !== 'default' ? `?user=${user}` : ''} and enable your Webcam.`
      );
    }

    // Validate URI
    if (request.params.uri !== "webcam://current") {
      throw new Error(
        "Invalid resource URI. Only webcam://current is supported."
      );
    }

    const clientId = Array.from(userClients.keys())[0];
    const userCallbacks = getUserCallbacks(user);

    // Capture image
    const result = await new Promise<string | { error: string }>((resolve) => {
      userCallbacks.set(clientId, resolve);
      userClients
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
      const userClients = getUserClients(user);
      if (userClients.size === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Have you opened your web browser?. Direct the human to go to ${getMcpHost()}${user !== 'default' ? `?user=${user}` : ''}, switch on their webcam and try again.`,
            },
          ],
        };
      }

      const clientId = Array.from(userClients.keys())[0];

      if (!clientId) {
        throw new Error("No clients connected");
      }

      const userCallbacks = getUserCallbacks(user);

      // Modified promise to handle both success and error cases
      const result = await new Promise<string | { error: string }>(
        (resolve) => {
          console.error(`Capturing for ${clientId} (user: ${user})`);
          userCallbacks.set(clientId, resolve);

          userClients
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
      const userClients = getUserClients(user);
      if (userClients.size === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Have you opened your web browser?. Direct the human to go to ${getMcpHost()}?user=${user}, switch on their webcam and try again.`,
            },
          ],
        };
      }

      const clientId = Array.from(userClients.keys())[0];

      if (!clientId) {
        throw new Error("No clients connected");
      }

      const userCallbacks = getUserCallbacks(user);

      // Modified promise to handle both success and error cases
      const result = await new Promise<string | { error: string }>(
        (resolve) => {
          console.error(`Taking screenshot for ${clientId} (user: ${user})`);
          userCallbacks.set(clientId, resolve);

          userClients
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