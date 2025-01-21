# mcp-webcam

Use your Webcam to send live images to Claude Desktop (or other MCP Client).  

Provides `"capture"` and `"screenshot"` tools to allow Claude to take a frame from the webcam or initiate taking a screenshot.

Provides a `current view from the webcam` resource too.

## Installation

NPM Package is `@llmindset/mcp-webcam`.

Will add Smithery instructions once package published and tested by myself.

Takes a single argument to set the Port for the embedded Express server. 

Default port is `3333` (to avoid conflict if using with Inspector).

Also need to test on Mac OS (my webcam is broken).

## Usage

Start Claude Desktop, and connect to `http://localhost:3333`. You can then ask Claude to `get the latest picture from my webcam`, or `Claude, take a look at what I'm holding` or `what colour top am i wearing?`. You can "freeze" the current image and that will be returned to Claude rather than a live capture. 

You can ask for Screenshots - navigate to the browser so that you can guide the capture area when the request comes in. Screenshots are automatically resized to be manageable for Claude (useful if you have a 4K Screen). The button is there to allow testing of your platform specific Screenshot UX - it doesn't do anything other than prepare you for a Claude intiated request. NB this does not **not** work on Safari as it requires human initiation.

## Other notes

That's it really. 

This MCP Server was built to demonstrate exposing a User Interface on an MCP Server, and serving live resources back to Claude Desktop.

This project might prove useful if you want to build a local, interactive MCP Server.

Please read the article at https://llmindset.co.uk/posts/2025/01/resouce-handling-mcp for more details about handling files and resources in LLM / MCP Chat Applications.
