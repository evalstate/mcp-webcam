# mcp-webcam 0.2.0 - the 50 Star Update

In celebration of getting 52 GitHub stars, `mcp-webcam 0.2.0` is here! Now supports streamable-http!!

![mcp_webcam_020_small](https://github.com/user-attachments/assets/515d25b2-0f95-40e0-88e8-07ba9fb2c5ff)

If we get to 100 stars I'll add even more features 😊.


# mcp-webcam

Use your Webcam to send live images to Claude Desktop (or other MCP Client).  

Provides `"capture"` and `"screenshot"` tools to allow Claude to take a frame from the webcam or initiate taking a screenshot.

Provides a `current view from the webcam` resource too.


## Installation

NPM Package is `@llmindset/mcp-webcam`.

Install a recent version of [NodeJS](https://nodejs.org/en/download) for your platform, then add the following to the `mcpServers` section of your `claude_desktop_config.json` file:

```
    "webcam": {
      "command": "npx",
      "args": [
        "-y",
        "@llmindset/mcp-webcam"
      ]
    }
```

As long as you are using Claude Desktop 0.78 or greater, this will work on both Windows and MacOS.

Takes a single argument to set the Port for the embedded Express server. 

Default port is `3333` (to avoid conflict if using with Inspector).

## Usage

Start Claude Desktop, and connect to `http://localhost:3333`. You can then ask Claude to `get the latest picture from my webcam`, or `Claude, take a look at what I'm holding` or `what colour top am i wearing?`. You can "freeze" the current image and that will be returned to Claude rather than a live capture. 

You can ask for Screenshots - navigate to the browser so that you can guide the capture area when the request comes in. Screenshots are automatically resized to be manageable for Claude (useful if you have a 4K Screen). The button is there to allow testing of your platform specific Screenshot UX - it doesn't do anything other than prepare you for a Claude intiated request. NB this does not **not** work on Safari as it requires human initiation.

## MCP Sampling

Press the "What am I holding?" button To send a Sampling request to the Client, containing the Image and the question `What is the User holding?`.

> [!TIP]
> Claude Desktop does not currently support Sampling. If you want a Client that can handle multi-modal sampling request, try https://github.com/evalstate/fast-agent/

## Other notes

That's it really. 

This MCP Server was built to demonstrate exposing a User Interface on an MCP Server, and serving live resources back to Claude Desktop.

This project might prove useful if you want to build a local, interactive MCP Server.

Thanks to  https://github.com/tadasant for help with testing and setup. 

Please read the article at [https://llmindset.co.uk/posts/2025/01/resouce-handling-mcp](https://llmindset.co.uk/posts/2025/01/mcp-files-resources-part1/) for more details about handling files and resources in LLM / MCP Chat Applications, and why you might want to do this.

## Third Party MCP Services

<a href="https://glama.ai/mcp/servers/plbefh6h9w"><img width="380" height="200" src="https://glama.ai/mcp/servers/plbefh6h9w/badge" alt="Webcam Server MCP server" /></a>
