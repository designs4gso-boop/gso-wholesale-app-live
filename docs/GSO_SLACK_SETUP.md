# GSO Slack Setup (owner)

## Local (already working)

1. Secrets file `C:/Users/Desig/.gso-secrets/slack.env` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TEST_CHANNEL`, `SLACK_SOCKET_MODE`. Never commit it; never paste values anywhere.
2. The bot is a member of the private channel `#gso-agent-sandbox` (id `C0C6H9M5U4W`). Private channels do not appear in `conversations.list` for this bot, but posting by name works.
3. Verify without printing secrets:

```bash
GSO_SLACK_LIVE=1 GSO_SLACK_RUN_KEY=<unique> npx vitest run tests/slack-sandbox-live.test.ts
```

This posts the nine sandbox scenario cards once, proves replay produces no second post, thread-replies, and opens/closes a Socket Mode connection. Re-running with the same run key posts nothing new in the same process; use a new key for a fresh set.

## Slack app configuration (when deploying — Phase 3)

- **Interactivity & Shortcuts:** ON, Request URL `https://<render-host>/api/slack/interactions`.
- **Event Subscriptions:** ON, same URL; subscribe to `app_mention` (read-only; nothing is executed from text).
- **Socket Mode:** only needed if a worker process exists (Phase 5).
- Scopes: see `GSO_SLACK_INTEGRATION_CONTRACT.md`.

## Staff mapping

Set `SLACK_STAFF_MAP` (JSON):

```json
{ "U0OWNER": { "staffId": "owner", "name": "Owner", "role": "owner" },
  "U0STAFF1": { "staffId": "staff-1", "name": "Staff One", "role": "staff" } }
```

Only mapped users can approve; only `owner` can approve OWNER_REQUIRED intents.

## Channels

Create (manually, by a human) the real channels when ready and set `SLACK_CHANNEL_*` env vars. Keep `SLACK_SANDBOX_ONLY=true` until Phase 6.
