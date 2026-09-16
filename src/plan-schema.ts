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
  entry: { type: "event"; eventName: string; propertyFilter?: PropertyFilter }
       | { type: "segment"; includeSegmentIds: string[] }
       | { type: "any" }
       | { type: "api" };
  exitOn?: { eventName?: string; segmentId?: string };
  reentry?: { mode: "once" } | { mode: "after"; after: Duration };
  steps: Step[];
}
\`\`\`

\`Duration\` is a string: "30m", "6h", "2d", "1w".
\`ClockTime\` is a 24-hour local time: "09:00", "17:30".

## Filtering an event by what it carried

"purchase" and "purchase over 100" are the same event to the engine. The
difference is a \`propertyFilter\`, allowed on \`entry\` and on any
\`await_milestone\`.

\`\`\`ts
type PropertyFilter =
  | { all: Condition[] }    // every condition must match
  | { any: Condition[] };   // at least one must match

type Condition = { fact: string; operator: Operator; value: unknown }
               | PropertyFilter;   // groups nest

type Operator =
  | "equal" | "notEqual"
  | "greaterThan" | "greaterThanInclusive"
  | "lessThan" | "lessThanInclusive"
  | "contains" | "doesNotContain"
  | "in" | "notIn";
\`\`\`

\`\`\`json
{ "all": [{ "fact": "total", "operator": "greaterThan", "value": 100 }] }
\`\`\`

\`fact\` is the event property key. **Call \`list_event_properties\` first.** Two
ways a filter silently does nothing, and neither raises an error:

- **The key never arrives.** The filter then turns away every event, and the
  journey enrols nobody while its readiness still reads OBSERVED.
- **The type is wrong.** Comparison is strict, so \`100\` does not match
  \`"100"\`. \`list_event_properties\` reports the type each key arrives as.

An operator outside the list above is rejected when the plan is parsed — which
is deliberate, because at run time an unusable filter is treated as *no* filter,
so a typo there would widen the journey rather than narrow it.

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
  propertyFilter?: PropertyFilter;    // only count the event when it matches
}
\`\`\`

\`at\` times are measured from the start of the step and must increase. "Nudge at
2 days, again at 5" is \`["2d", "5d"]\` — not \`["2d", "3d"]\`. Anyone who fires
\`event\` leaves the step immediately, so you never wire the success path yourself.

With a \`propertyFilter\`, only a matching event releases them — "wait for a
payment over 100" rather than "wait for any payment". Without one, any event of
that name advances the user.

**send** — send one message and move on.

\`\`\`ts
{
  kind: "send";
  channel: "PUSH" | "EMAIL" | "SMS";
  content: {...};
  label?: string;
  ref?: string;               // name it so a later branch can ask if it was opened
}
\`\`\`

**wait** — pause for a fixed duration.

\`\`\`ts
{ kind: "wait"; duration: Duration; label?: string }
\`\`\`

**time_window** — hold users until the clock *where they live* is inside the window.

\`\`\`ts
{
  kind: "time_window";
  days: ("sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat")[];   // at least one
  start: ClockTime;           // inclusive
  end: ClockTime;             // exclusive, must be after start
  timezone?: string;          // IANA zone for users with none on file
  label?: string;
}
\`\`\`

This is not the same as \`wait\`. A wait is relative — "three days from now" lands
at 3am as readily as at noon. A time window is absolute against the user's own
day, and it is the only way to express "never wake anyone at 4am". Put one
directly before a \`send\` when the message has a sensible hour.

A window cannot cross midnight. Set \`timezone\` unless the audience really is
global — users with no zone on file are otherwise treated as UTC.

**split** — divide users between paths to test variants or hold a control group back.

\`\`\`ts
{
  kind: "split";
  label?: string;
  paths: {                    // note: "paths", not "arms" — a branch has arms
    weight: number;           // relative share, > 0; 50/50 and 1/1 are the same
    variant?: string;         // reporting label — "control", "variant-a"
    label?: string;
    steps: Step[];
  }[];                        // at least two
}
\`\`\`

Paths rejoin whatever follows, and there is no \`otherwise\` — every user lands on
one. Which one is a stable function of the user and this node, so a user is
never moved mid-experiment. Give every path a \`variant\` if you want the results
grouped by name rather than by percentage. A holdout is just a path whose steps
skip the message.

**branch** — route down one of several paths; arms rejoin whatever follows.

\`\`\`ts
{
  kind: "branch";
  label?: string;
  arms: {
    when: { type: "segment"; segmentId: string }
        | { type: "tag"; tagKey: string;
            operator: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"|"exists";
            value?: unknown }
        | { type: "message_engagement"; ref: string;
            engagement: "delivered"|"opened"|"clicked"; negate?: boolean };
    label?: string;
    steps: Step[];
  }[];
  otherwise?: Step[];         // omit to fall straight through
}
\`\`\`

\`message_engagement\` asks about a specific earlier message by its \`ref\`. Give
the send a \`ref\`, then name it: \`{ "type": "message_engagement", "ref": "welcome",
"engagement": "opened", "negate": true }\` is "everyone who didn't open the
welcome push". \`delivered\` means the device confirmed receipt, not that the
provider accepted it.

The ref must belong to a send **earlier on the same path**. A ref defined inside
one branch arm is not visible from a sibling arm — those users never got that
message — and the plan is rejected rather than compiled into a branch that can
never be true.

Put a \`wait\` between the send and the branch. The message has not been delivered
at the instant the send step finishes, so a branch placed immediately after it
finds nobody has opened anything and sends every user down the same arm. The
plan is rejected if you forget.

Careful with \`negate\` on a nudge that not everyone reaches: "did not open" is
also true for a user who was never sent it.

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

## Example: a subject-line test that respects business hours

Ten percent are held back entirely, so the lift is measured against people who
got nothing rather than against the other variant.

\`\`\`json
{
  "name": "Onboarding nudge test",
  "entry": { "type": "event", "eventName": "signup" },
  "reentry": { "mode": "once" },
  "steps": [
    { "kind": "wait", "duration": "1d" },
    {
      "kind": "time_window",
      "label": "Business hours",
      "days": ["sun", "mon", "tue", "wed", "thu"],
      "start": "09:00",
      "end": "17:00",
      "timezone": "Asia/Qatar"
    },
    {
      "kind": "split",
      "label": "Subject line test",
      "paths": [
        {
          "weight": 45,
          "variant": "variant-a",
          "steps": [
            { "kind": "send", "ref": "nudge_a", "channel": "EMAIL",
              "content": { "subject": "Your account is ready",
                           "body": "Finish setting up to start sending." } }
          ]
        },
        {
          "weight": 45,
          "variant": "variant-b",
          "steps": [
            { "kind": "send", "ref": "nudge_b", "channel": "EMAIL",
              "content": { "subject": "One step left",
                           "body": "Finish setting up to start sending." } }
          ]
        },
        {
          "weight": 10,
          "variant": "holdout",
          "steps": [{ "kind": "exit", "label": "Holdout — no message" }]
        }
      ]
    }
  ]
}
\`\`\`

Note that \`nudge_a\` is only visible inside its own path. A branch after the split
cannot ask whether it was opened, because most users at that point were never
sent it. To follow up on non-openers, put the wait and the branch *inside* the
path, after the send:

\`\`\`json
"steps": [
  { "kind": "send", "ref": "nudge_a", "channel": "EMAIL", "content": { "…": "…" } },
  { "kind": "wait", "duration": "2d" },
  {
    "kind": "branch",
    "arms": [
      {
        "when": { "type": "message_engagement", "ref": "nudge_a",
                  "engagement": "opened", "negate": true },
        "label": "Didn't open",
        "steps": [
          { "kind": "send", "channel": "PUSH",
            "content": { "title": "Still there?", "body": "Your setup is waiting." } }
        ]
      }
    ]
  }
]
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
