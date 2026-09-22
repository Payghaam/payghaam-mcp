#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PayghaamClient } from "./client.js";
import { registerTools } from "./tools.js";
import { loadCredentials, runLoginFlow, runLogoutFlow } from "./auth.js";

const DEFAULT_API_URL = "https://api.payghaam.com/api";

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === "login") {
    const apiUrl = getArgValue("--api-url");
    const dashboardUrl = getArgValue("--dashboard-url");
    await runLoginFlow({ apiUrl, dashboardUrl });
    return;
  }

  if (cmd === "logout") {
    const apiUrl = getArgValue("--api-url");
    await runLogoutFlow({ apiUrl });
    return;
  }

  const baseUrl = process.env.PAYGHAAM_API_URL?.trim() || DEFAULT_API_URL;
  const apiKey = process.env.PAYGHAAM_API_KEY?.trim();
  let accessToken: string | undefined;

  if (!apiKey) {
    const creds = await loadCredentials(baseUrl);
    accessToken = creds?.accessToken;
  }

  if (!apiKey && !accessToken) {
    // stderr, not stdout: stdout is the JSON-RPC channel and anything written
    // there that isn't a protocol message breaks the client's parser.
    process.stderr.write(
      "No Payghaam credentials found.\n\n" +
        "To authenticate:\n" +
        "  1. Run `npx @payghaam/mcp-server login` to log in via your browser, OR\n" +
        "  2. Create an MCP key in the Payghaam dashboard under Project settings → Code, " +
        "then set PAYGHAAM_API_KEY in your MCP client config.\n",
    );
    process.exit(1);
  }

  const client = new PayghaamClient({
    apiKey,
    accessToken,
    baseUrl,
  });

  const server = new McpServer({
    name: "payghaam",
    version: "0.2.0",
  });

  registerTools(server, client);

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`payghaam-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
