import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PayghaamApiError,
  type EventReadiness,
  type PayghaamClient,
  type Platform,
} from "./client.js";
import { PLAN_SCHEMA_DOC } from "./plan-schema.js";

const PLATFORMS = ["FLUTTER", "ANDROID", "IOS", "REACT_NATIVE", "WEB"] as const;

/**
 * Behaviour hints for the client, per the MCP spec.
 *
 * Unannotated tools are assumed write-capable and destructive, so without these
 * a client would prompt for confirmation before merely listing journeys. They
 * are hints for presentation only — never a security boundary. What an MCP key
 * can actually reach is enforced server-side by the key type, and stays true
 * whatever this file claims.
 *
 * `openWorldHint` is false throughout: every call resolves against one project
 * in one API, which is a closed domain even though its contents change.
 */
const READS = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * Additive and idempotent: it only ever upserts event definitions, never
 * deletes, and never downgrades an event the app is already sending. Declaring
 * the same names twice leaves the same state, so a client is free to retry.
 */
const DECLARE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Additive — it only ever creates a new draft, never touches an existing
 * journey — but not idempotent: calling twice makes two drafts. Clients should
 * confirm rather than retry silently.
 */
const DRAFT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Register everything the agent can do.
 *
 * The split of labour is the point: we supply what the product is waiting for,
 * and the agent — which has the repo, the imports, the type checker and the
 * test suite — decides where in the code that belongs. We deliberately do not
 * try to tell it where to put the call.
 */
export function registerTools(server: McpServer, client: PayghaamClient): void {
  // The plan format lives in a resource rather than a tool description: it is
  // long, it is only needed when someone is actually drafting, and a tool
  // description is paid for on every tools/list by every session.
  server.registerResource(
    "journey-plan-schema",
    "payghaam://journey-plan-schema",
    {
      title: "Journey plan format",
      description:
        "How to write a journey plan for create_journey_draft, with a worked example.",
      mimeType: "text/markdown",
    },
    () => ({
      contents: [
        {
          uri: "payghaam://journey-plan-schema",
          mimeType: "text/markdown",
          text: PLAN_SCHEMA_DOC,
        },
      ],
    }),
  );

  server.registerTool(
    "list_expected_events",
    {
      title: "List events the app doesn't send yet",
      description:
        "Events that this project's journeys wait on but which have never arrived from the app. Each one is a step where users currently get stuck forever. Start here.",
      inputSchema: {},
      annotations: READS,
    },
    async () =>
      run(async () => {
        const events = await client.expectedEvents();
        if (events.length === 0) {
          return "Every event this project's journeys depend on is already arriving. There is nothing to instrument.";
        }
        return events
          .map((event) => {
            const journeys = event.neededBy.map((j) => j.journeyName).join(", ");
            const state =
              event.status === "DECLARED"
                ? "already added to the code, but nothing has arrived yet — the build may not have shipped"
                : "not in the code anywhere";
            return `${event.name}\n  needed by: ${journeys || "no active journey"}\n  status: ${state}`;
          })
          .join("\n\n");
      }),
  );

  server.registerTool(
    "list_journeys",
    {
      title: "List journeys",
      description:
        "Every active journey in this project and the events each one depends on.",
      inputSchema: {},
      annotations: READS,
    },
    async () =>
      run(async () => {
        const journeys = await client.journeys();
        if (journeys.length === 0) return "This project has no journeys yet.";
        return journeys
          .map((j) => `${j.name} (${j.status})\n  id: ${j.id}\n  events: ${j.events.join(", ") || "none"}`)
          .join("\n\n");
      }),
  );

  server.registerTool(
    "describe_journey",
    {
      title: "Describe a journey",
      description:
        "What one journey does, step by step in plain English, plus the state of every event it needs. Use this to understand what a missing event actually blocks before deciding where to track it.",
      inputSchema: {
        journeyId: z.string().describe("From list_journeys."),
      },
      annotations: READS,
    },
    async ({ journeyId }) =>
      run(async () => {
        const journey = await client.journey(journeyId);
        const steps = journey.steps.map((s, i) => `  ${i + 1}. ${s.detail}`).join("\n");
        return [
          `${journey.name} (${journey.status})`,
          "",
          "What happens:",
          steps || "  (no steps)",
          "",
          `Events (${journey.ready}/${journey.total} arriving):`,
          formatReadiness(journey.events),
        ].join("\n");
      }),
  );

  server.registerTool(
    "generate_event_constants",
    {
      title: "Generate typed event constants",
      description:
        "The generated constants file for this project's events, in the language you ask for. Write it into the repo and call the constants instead of string literals — event matching is exact, so a typo is a journey that silently never advances. Regenerating produces an identical file.",
      inputSchema: {
        platform: z.enum(PLATFORMS).describe("The language to generate for."),
        packageName: z
          .string()
          .optional()
          .describe(
            "Android only. The package of the directory you're writing the file into, e.g. com.acme.wallet.",
          ),
        events: z
          .array(z.string())
          .optional()
          .describe("Restrict to these events. Omit for every event the project is waiting on."),
      },
      annotations: READS,
    },
    async ({ platform, packageName, events }) =>
      run(async () => {
        const result = await client.constants({
          platform: platform as Platform,
          packageName,
          events,
        });
        if (!result.content) return result.note ?? "Nothing to generate.";
        return [
          `Suggested path: ${result.path} (put it wherever this repo's source actually lives)`,
          result.note ? `Note: ${result.note}` : "",
          "",
          result.content,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "mark_events_declared",
    {
      title: "Report events as added to the code",
      description:
        "Call this once you have actually written the tracking calls. It tells the dashboard the events exist in the app but haven't arrived yet, which distinguishes 'nobody has done this' from 'done, waiting on a release'. Do not call it for events you only planned to add.",
      inputSchema: {
        events: z
          .array(z.string())
          .min(1)
          .describe("The event names you added tracking calls for."),
      },
      annotations: DECLARE,
    },
    async ({ events }) =>
      run(async () => {
        const readiness = await client.declare(events);
        return [
          `Recorded ${events.length} event(s) as present in the app's code.`,
          "",
          formatReadiness(readiness),
          "",
          "These flip to arriving on their own once a build ships and real users hit those paths. Nothing else to do in the dashboard.",
        ].join("\n");
      }),
  );

  server.registerTool(
    "create_journey_draft",
    {
      title: "Draft a journey",
      description:
        "Create a DRAFT journey from a plan. Read the payghaam://journey-plan-schema resource first — it has the format and a worked example. The draft sends nothing; a person reviews and activates it in the dashboard, and it is labelled there as machine-written. Requires an author key (ek_mcpa_). If the plan is invalid you get the specific problems back and can fix and retry.",
      inputSchema: {
        plan: z
          .record(z.unknown())
          .describe("A journey plan object, per payghaam://journey-plan-schema."),
      },
      annotations: DRAFT,
    },
    async ({ plan }) =>
      run(async () => {
        const journey = await client.createDraft(plan);
        return [
          `Created draft "${journey.name}" (${journey.id}).`,
          "",
          "What it does:",
          journey.steps.map((s, i) => `  ${i + 1}. ${s.detail}`).join("\n") || "  (no steps)",
          "",
          journey.warnings.length ? `Warnings:\n${journey.warnings.map((w) => `  - ${w}`).join("\n")}\n` : "",
          "Events it depends on:",
          formatReadiness(journey.events),
          "",
          "It is a draft and will not send anything until someone activates it in the dashboard. Tell the developer to review it there.",
        ]
          .filter((line) => line !== "")
          .join("\n");
      }),
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Project overview",
      description:
        "Which Payghaam project this key belongs to and whether anything needs instrumenting.",
      inputSchema: {},
      annotations: READS,
    },
    async () =>
      run(async () => {
        const context = await client.context();
        return [
          `Project: ${context.project}`,
          `Journeys: ${context.journeys}`,
          context.summary,
        ].join("\n");
      }),
  );
}

function formatReadiness(events: EventReadiness[]): string {
  if (events.length === 0) return "  (none)";
  return events
    .map((event) => {
      switch (event.status) {
        case "OBSERVED":
          return `  ${event.name} — arriving (${event.count.toLocaleString()} in the last 90 days)`;
        case "DECLARED":
          return `  ${event.name} — in the code, nothing received yet`;
        default:
          return `  ${event.name} — not sent by the app`;
      }
    })
    .join("\n");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Every tool returns text, and a failure is text too.
 *
 * Throwing across the MCP boundary gives the agent a stack trace it can do
 * nothing with. An error it can read — "your key is the wrong type" — is one it
 * can either fix or report to the developer sitting right there.
 */
async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message =
      err instanceof PayghaamApiError ? err.message : `Unexpected failure: ${String(err)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
