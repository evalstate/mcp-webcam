# ⭐⭐ mcp-webcam 0.2.0 - the 50 Star Update ⭐⭐ 

In celebration of getting 52 GitHub stars, `mcp-webcam 0.2.0` is here! Now supports streamable-http!!

![mcp_webcam_020_thumb](https://github.com/user-attachments/assets/041e3091-71e5-4aa1-9170-ee20177485ef)

If we get to 100 stars I'll add another feature 😊.

## mcp-webcam

MCP Server that provides access to your WebCam. Provides `capture` and `screenshot` tools to take an image from the Webcam, or take a screenshot. The current image is also available as a Resource.

### MCP Sampling

`mcp-webcam` supports "sampling"! Press the "Sample" button to send a sampling request to the Client along with your entered message. 

> [!TIP]
> Claude Desktop does not currently support Sampling. If you want a Client that can handle multi-modal sampling request, try https://github.com/evalstate/fast-agent/ or VSCode (more details below).

## Installation and Running

Install a recent version of [NodeJS](https://nodejs.org/en/download) for your platform. The NPM package is `@llmindset/mcp-webcam`. 

To start in **STDIO** mode: `npx @llmindset/mcp-webcam`. This starts the `mcp-webcam` UI on port 3333. Point your browser at `http://localhost:3333` to get started.

To change the port: `npx @llmindset/mcp-webcam 9999`. This starts `mcp-webcam` the UI on port 9999.

For **Streaming HTTP** mode: `npx @llmindset/mcp-webcam --streaming`. This will make the UI available at `http://localhost:3333` and the MCP Server available at `http://localhost:3333/mcp`.

If you want a Client that supports sampling try:

### fast-agent

Start the server in streaming mode, install [`uv`](https://docs.astral.sh/uv/) and connect with:

`uvx fast-agent-mcp go --url http://localhost:3333/mcp`

`fast-agent` currently uses Haiku as its default model, so set an `ANTHROPIC_API_KEY`. If you want to use a different model, you can add `--model` on the command line. More instructions for installation and configuration are available here: https://fast-agent.ai/models/.

To start the server in STDIO mode, add the following to your `fastagent.config.yaml`

```yaml
webcam_local:
   command: "npx"
   args: ["@llmindset/mcp-webcam"]
```

### VSCode

VSCode versions 1.101.0 and above support MCP Sampling. Simply add `http://localhost:3333/mcp` as an MCP Server to get started.

### Claude Desktop

Claude Desktop does **NOT** support Sampling. To run `mcp-webcam` from Claude Desktop, add the following to the `mcpServers` section of your `claude_desktop_config.json` file:

```json
    "webcam": {
      "command": "npx",
      "args": [
        "-y",
        "@llmindset/mcp-webcam"
      ]
    }
```

Start Claude Desktop, and connect to `http://localhost:3333`. You can then ask Claude to `get the latest picture from my webcam`, or `Claude, take a look at what I'm holding` or `what colour top am i wearing?`. You can "freeze" the current image and that will be returned to Claude rather than a live capture. 

You can ask for Screenshots - navigate to the browser so that you can guide the capture area when the request comes in. Screenshots are automatically resized to be manageable for Claude (useful if you have a 4K Screen). The button is there to allow testing of your platform specific Screenshot UX - it doesn't do anything other than prepare you for a Claude intiated request. NB this does not **not** work on Safari as it requires human initiation.

## Other notes

That's it really. 

This MCP Server was built to demonstrate exposing a User Interface on an MCP Server, and serving live resources back to Claude Desktop.

This project might prove useful if you want to build a local, interactive MCP Server.

Thanks to  https://github.com/tadasant for help with testing and setup. 

Please read the article at [https://llmindset.co.uk/posts/2025/01/resouce-handling-mcp](https://llmindset.co.uk/posts/2025/01/mcp-files-resources-part1/) for more details about handling files and resources in LLM / MCP Chat Applications, and why you might want to do this.
