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
      "create_journey_draft",
      "describe_journey",
      "generate_event_constants",
      "get_project_context",
      "list_event_properties",
      "list_expected_events",
      "list_journeys",
      "mark_events_declared",
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
    expect(byName.get("create_journey_draft")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });

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
