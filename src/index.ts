#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PayghaamClient } from "./client.js";
import { registerTools } from "./tools.js";

const DEFAULT_API_URL = "https://api.payghaam.com/api";

async function main(): Promise<void> {
  const apiKey = process.env.PAYGHAAM_API_KEY?.trim();
  if (!apiKey) {
    // stderr, not stdout: stdout is the JSON-RPC channel and anything written
    // there that isn't a protocol message breaks the client's parser.
    process.stderr.write(
      "PAYGHAAM_API_KEY is not set.\n" +
        "Create an MCP key in the Payghaam dashboard under Project settings → Code, " +
        "then set it in your MCP client config.\n",
    );
    process.exit(1);
  }

  const client = new PayghaamClient({
    apiKey,
    baseUrl: process.env.PAYGHAAM_API_URL?.trim() || DEFAULT_API_URL,
  });

  const server = new McpServer({
    name: "payghaam",
    version: "0.1.0",
  });

  registerTools(server, client);

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`payghaam-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
