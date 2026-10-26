# Changelog

## 0.5.0

- Expanded tool catalog to full Copilot parity (33 tools total).
- Added Project Overview, Channels, Webhooks, and Issues discovery tools (`get_project_overview`, `list_channels`, `list_webhook_connections`, `list_issues`).
- Added Campaign listing, analytics, drafting, and proposal tools (`list_campaigns`, `get_campaign_analytics`, `propose_campaign`, `save_campaign_draft`).
- Added Template management for Email & Multi-Channel messaging (`list_email_templates`, `get_email_template`, `propose_email_template`, `save_email_template`, `list_message_templates`, `get_message_template`, `propose_message_template`, `save_message_template`).
- Added Delivery diagnostics and root-cause explanation (`list_recent_deliveries`, `explain_delivery`).
- Added Audience, Subscriber, and Subscription inspection (`get_subscriber`, `list_segments`, `list_subscriptions`, `get_subscription`).
- Added Journey readiness check and event names lookup (`check_journey_readiness`, `list_event_names`).

## 0.3.0

- Add OAuth 2.0 PKCE authentication (`payghaam-mcp login` and `payghaam-mcp logout`).
- Auto-refresh access tokens from `~/.payghaam/credentials.json`.
- Add Cursor Marketplace plugin manifest (`.cursor-plugin/plugin.json`).
- Add Smithery 1-click install manifest (`smithery.yaml`).

## 0.1.0

- Initial release: `get_project_context`, `list_expected_events`,
  `list_journeys`, `describe_journey`, `generate_event_constants`,
  `mark_events_declared`.
