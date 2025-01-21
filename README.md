# mcp-webcam

Use your Webcam to send live images to Claude Desktop (or other MCP Client). 

Also contains Assistant driven screenshots (user intervention required).

## Installation

Package is @llmindset/mcp-webcam. Entry point is /dist/server.ts

Takes a single argument to set the Port for the embedded Express server. Default is 3333 (so it doesn't conflict with Inspector).

TBC - will add Smithery instructions once package published and tested by myself.

Also need to test on Mac OS (my webcam is broken).

## Usage

Start Claude Desktop, and connect to `http://localhost:3333`. You can then ask Claude to `get the latest picture from my webcam`, or `Claude, take a look at what I'm holding`.

You can ask for Screenshots - navigate to the browser so that you can guide the capture area when the request comes in. Screenshots are automatically resized to be manageable for Claude (useful if you have a 4K Screen). NB this does not **not** work on Safari as it requires human initiation.

## Other notes

That's it really. This is a demonstration of supplying Resources to Claude's context via an MCP Server UI. This project might prove useful if you want to build a local, interactive MCP Server.

Please read the article at https://llmindset.co.uk/posts/2025/01/resouce-handling-mcp for more details about handling files and resources in LLM / MCP Chat Applications.
