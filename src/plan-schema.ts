/**
 * The journey plan format, written for the agent that has to author one.
 *
 * Served as an MCP resource rather than stuffed into the tool description, so
 * it costs nothing on every `tools/list` and is fetched only when someone is
 * actually drafting. The API is the real validator — its errors name the exact
 * path that failed — so this document only has to get an agent close enough to
 * a first attempt.
 */
export const PLAN_SCHEMA_DOC = `# Payghaam journey plan

A plan describes *intent*. The server compiles it into an executable graph, so
you never position nodes or wire edges yourself.

\`\`\`ts
{
  name: string;
  description?: string;
  entry: { type: "event"; eventName: string }
       | { type: "segment"; includeSegmentIds: string[] }
       | { type: "any" }
       | { type: "api" };
  exitOn?: { eventName?: string; segmentId?: string };
  reentry?: { mode: "once" } | { mode: "after"; after: Duration };
  steps: Step[];
}
\`\`\`

\`Duration\` is a string: "30m", "6h", "2d", "1w".

## Steps

**await_milestone** — wait for the user to do something, nudging while they haven't.
This is the step you want for "someone is stuck".

\`\`\`ts
{
  kind: "await_milestone";
  event: string;              // the event that means they finished
  label?: string;
  nudges: {
    at: Duration;             // CUMULATIVE from entering the step, not a gap
    channel: "PUSH" | "EMAIL" | "SMS";
    content: Record<string, unknown>;
    label?: string;
  }[];                        // [] = wait forever with no reminders
  onExhausted: "continue" | "exit";   // after the last nudge elapses
}
\`\`\`

\`at\` times are measured from the start of the step and must increase. "Nudge at
2 days, again at 5" is \`["2d", "5d"]\` — not \`["2d", "3d"]\`. Anyone who fires
\`event\` leaves the step immediately, so you never wire the success path yourself.

**send** — send one message and move on.

\`\`\`ts
{ kind: "send"; channel: "PUSH" | "EMAIL" | "SMS"; content: {...}; label?: string }
\`\`\`

**wait** — pause for a fixed duration.

\`\`\`ts
{ kind: "wait"; duration: Duration; label?: string }
\`\`\`

**branch** — route down one of several paths; arms rejoin whatever follows.

\`\`\`ts
{
  kind: "branch";
  label?: string;
  arms: {
    when: { type: "segment"; segmentId: string }
        | { type: "tag"; tagKey: string;
            operator: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"|"exists";
            value?: unknown };
    label?: string;
    steps: Step[];
  }[];
  otherwise?: Step[];         // omit to fall straight through
}
\`\`\`

**set_tag** — \`{ kind: "set_tag"; tagKey: string; tagValue: unknown; label?: string }\`

**exit** — \`{ kind: "exit"; label?: string }\`

## Content by channel

- PUSH: \`{ "title": "...", "body": "..." }\`
- EMAIL: \`{ "subject": "...", "body": "..." }\`
- SMS: \`{ "body": "..." }\`

## Example: recovering users stuck at top-up

\`\`\`json
{
  "name": "Top-up recovery",
  "entry": { "type": "event", "eventName": "top_up_started" },
  "reentry": { "mode": "once" },
  "steps": [
    {
      "kind": "await_milestone",
      "event": "top_up_completed",
      "label": "Waiting for first top-up",
      "onExhausted": "exit",
      "nudges": [
        { "at": "1d", "channel": "PUSH",
          "content": { "title": "Finish setting up your wallet",
                       "body": "Add funds to start paying with your card." } },
        { "at": "3d", "channel": "EMAIL",
          "content": { "subject": "You're one step away",
                       "body": "Your account is ready — add funds to get going." } },
        { "at": "5d", "channel": "SMS",
          "content": { "body": "Add funds to start using your card." } }
      ]
    }
  ]
}
\`\`\`

## Before you draft

Messages cost real money and reach real people, so a plan is saved as a DRAFT and
someone has to review and activate it. Two things are worth checking first:

- **Channels need a reachable subscription.** An SMS step does nothing for users
  whose phone number the app hasn't registered yet. In onboarding journeys that
  is often exactly the users being targeted.
- **Re-entry.** Without \`{ "mode": "once" }\`, a user who triggers the entry event
  five times enters five times and gets five sets of nudges.
`;
