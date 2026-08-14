# @payghaam/mcp-server

An MCP server that tells your coding agent which analytics events your Payghaam journeys are waiting for, so it can add them to your app.

## Why this exists

A journey step that waits for `kyc_completed` does nothing at all if your app never sends `kyc_completed`. It doesn't error — users simply arrive at that step and stay there. This server exposes which events are missing, what they block, and generated constants to call, and then lets your own agent decide where in the code they belong.

Your code never leaves your machine. This server only reads journey and event metadata from Payghaam.

## Setup

Create an MCP key in the Payghaam dashboard under **Project settings → Code**. It starts with `ek_mcp_`.

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "payghaam": {
      "command": "npx",
      "args": ["-y", "@payghaam/mcp-server"],
      "env": { "PAYGHAAM_API_KEY": "ek_mcp_..." }
    }
  }
}
```

### Claude Code

```bash
claude mcp add payghaam --env PAYGHAAM_API_KEY=ek_mcp_... -- npx -y @payghaam/mcp-server
```

Both files tend to end up in git. An MCP key is read-mostly by design — it cannot send messages, enroll users, or read a single subscriber — but treat it as a secret anyway and revoke it from the dashboard if it leaks.

## Environment

| Variable | Required | Default |
| --- | --- | --- |
| `PAYGHAAM_API_KEY` | yes | — |
| `PAYGHAAM_API_URL` | no | `https://api.payghaam.com/api` |

## Tools

- `get_project_context` — which project this key belongs to and whether anything needs instrumenting
- `list_expected_events` — events your journeys wait on that your app has never sent
- `list_journeys` — active journeys and the events each depends on
- `describe_journey` — one journey in plain English, with the state of every event it needs
- `generate_event_constants` — the typed constants file for Dart, Kotlin, Swift or TypeScript
- `mark_events_declared` — report back that you've added the tracking calls

## A typical session

> "Add the Payghaam events my onboarding journey needs."

The agent calls `list_expected_events`, sees `kyc_completed` and `card_issued` are missing and that onboarding depends on both, calls `describe_journey` to understand what stalls, writes the generated constants file, adds the tracking calls on the success paths it finds in your code, and calls `mark_events_declared`.

Your dashboard then shows those events as present in the code but not yet arriving. Once a build ships and real users hit those paths, they flip to arriving on their own and the journey's readiness climbs without anyone touching it.

## License

MIT
