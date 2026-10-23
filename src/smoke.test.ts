import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface RpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; description?: string; annotations?: ToolAnnotations }[];
  };
  error?: { message: string };
}

/**
 * Speak the protocol to the built binary the way a client does.
 *
 * A unit test on `registerTools` would pass even if the server never came up,
 * the shebang were mangled, or the SDK's ESM entry failed to resolve under
 * node16 — all failures that would only appear on a customer's machine.
 *
 * It spawns the *built* entry point, which is what makes it honest and is also
 * its one trap: run without a build it tests the previous release and passes
 * whatever src says. `pretest` builds for that reason — a tool added to src and
 * missing from the compiled output looked green here until the build ran.
 */
function callServer(messages: unknown[]): Promise<RpcResponse[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, PAYGHAAM_API_KEY: "ek_mcp_test", PAYGHAAM_API_URL: "http://127.0.0.1:9" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", reject);

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    setTimeout(() => {
      child.kill();
      resolvePromise(
        out
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RpcResponse),
      );
    }, 2500);
  });
}

describe("payghaam-mcp over stdio", () => {
  it("initializes and advertises its tools", async () => {
    const responses = await callServer([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const tools = responses.find((r) => r.id === 2)?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_journey_readiness",
      "create_journey_draft",
      "describe_journey",
      "explain_delivery",
      "generate_event_constants",
      "get_campaign_analytics",
      "get_email_template",
      "get_message_template",
      "get_project_context",
      "get_project_overview",
      "get_subscriber",
      "get_subscription",
      "list_campaigns",
      "list_channels",
      "list_email_templates",
      "list_event_names",
      "list_event_properties",
      "list_expected_events",
      "list_issues",
      "list_journeys",
      "list_message_templates",
      "list_recent_deliveries",
      "list_segments",
      "list_subscriptions",
      "list_webhook_connections",
      "mark_events_declared",
      "propose_campaign",
      "propose_email_template",
      "propose_message_template",
      "save_campaign_draft",
      "save_email_template",
      "save_message_template",
      "update_journey_draft",
    ]);
  }, 15_000);

  it("advertises the reads as read-only so clients don't prompt for them", async () => {
    const responses = await callServer([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const tools = responses.find((r) => r.id === 2)?.result?.tools ?? [];
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));

    for (const name of [
      "list_event_properties",
      "list_expected_events",
      "list_journeys",
      "describe_journey",
      "generate_event_constants",
      "get_project_context",
      "get_project_overview",
      "list_channels",
      "list_webhook_connections",
      "list_issues",
      "list_campaigns",
      "get_campaign_analytics",
      "propose_campaign",
      "list_email_templates",
      "get_email_template",
      "propose_email_template",
      "list_message_templates",
      "get_message_template",
      "propose_message_template",
      "list_recent_deliveries",
      "explain_delivery",
      "get_subscriber",
      "list_segments",
      "list_subscriptions",
      "get_subscription",
      "check_journey_readiness",
      "list_event_names",
    ]) {
      expect(byName.get(name), name).toMatchObject({ readOnlyHint: true });
    }

    // Additive and safe to retry, which is what lets a client recover from a
    // dropped response without double-declaring.
    expect(byName.get("mark_events_declared")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    // Also additive, but calling it twice makes two drafts — so it must not
    // claim idempotency and invite a silent retry.
    for (const draftTool of [
      "create_journey_draft",
      "save_campaign_draft",
      "save_email_template",
      "save_message_template",
    ]) {
      expect(byName.get(draftTool), draftTool).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }

    // The opposite shape: it overwrites an existing draft's plan wholesale
    // (destructive), but submitting the same plan twice leaves the same
    // result (idempotent) — unlike create, which would make a second draft.
    expect(byName.get("update_journey_draft")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  }, 15_000);

  it("returns an unreachable API as readable text, not a crash", async () => {
    const responses = await callServer([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_expected_events", arguments: {} },
      },
    ]);

    const call = responses.find((r) => r.id === 3);
    expect(call?.error).toBeUndefined();
    const text = JSON.stringify(call?.result);
    expect(text).toMatch(/Could not reach/);
  }, 15_000);
});
