# GSO Slack Integration Contract

**Workspace app:** `gso_operations` (verified via `auth.test` on 2026-10-03). **Live channel tonight:** `#gso-agent-sandbox` only.

## What Slack is for

Slack is a **notification and approval surface**. It is never a command line. The only things a Slack interaction can do are the five decisions on a local `ActionIntent`: APPROVE, REJECT, REQUEST CHANGES, HOLD, RELEASE. "OPEN IN ERP" is a plain URL button.

## Logical destinations → channels

`sandbox, sales_leads, sales_quotes, art_approval, production, production_exceptions, purchasing, shipping, finance, agent_approvals, management_reports`

Each maps to an env var (`SLACK_CHANNEL_<NAME>`); none is hardcoded. While `SLACK_SANDBOX_ONLY` ≠ `"false"` **every** destination resolves to `SLACK_TEST_CHANNEL` and the card is prefixed `SANDBOX — would post to <destination>`. An unconfigured destination also falls back to the sandbox.

## Security

- **HTTP mode:** `X-Slack-Signature` v0 HMAC-SHA256 over `v0:<ts>:<rawBody>` verified with a timing-safe compare; timestamps older than 5 minutes rejected; verification happens before parsing.
- **Socket Mode:** connection authenticated by the app-level token at `apps.connections.open`; envelopes ACKed immediately, then de-duplicated.
- **De-duplication:** `event_id` / `envelope_id` for events; `(user, message_ts, action_id, value)` for clicks; `X-Slack-Retry-Num` surfaced.
- **Allow-list:** action ids `gso_intent_approve|reject|request_changes|hold|release`, `gso_open_erp`. Button value must match the intent id grammar `ai_<8hex>_<n>`.
- **Identity:** Slack user id → `SLACK_STAFF_MAP` → ERP staff id + role. Unmapped users cannot decide anything.
- **Untrusted text:** modal/comment text is stored as a comment, scanned, and flagged in the audit if instruction-like; never executed.
- **Secrets:** loaded from `C:/Users/Desig/.gso-secrets/slack.env` (local) or `process.env` (Render); never logged (`describeSlackEnv` prints present/MISSING only); never committed.

## Block Kit

Builders in `app/lib/slack/slack-blocks.ts`: `agentOnlineBlocks`, `newLeadBlocks`, `intentCard`, `reportBlocks`, `exceptionBlocks`, `decisionActions`, `decisionResultText`. PII in facts is redacted (`redactForLog`). Decision buttons appear only while the intent is `AWAITING_APPROVAL`.

## Idempotent posting

`SlackClient.postBlocks({ idempotencyKey })` posts once per `(channel, key)` per process and returns `duplicate: true` with the original `ts` on replay. The durable store (deployment Phase 2) extends this across processes.

## Scopes needed for this design

Bot: `chat:write`, `channels:read`, `groups:read`, `app_mentions:read`, `channels:history` (read-only sandbox checks). App-level: `connections:write` (Socket Mode). Nothing that can create/delete channels, invite/remove users, or DM arbitrary users is required or used.

## Slack can never

post to a non-sandbox channel while sandbox-only is on · DM staff automatically · create/delete channels · invite/remove users · change workspace config · message customers · approve real art, move jobs, create invoices/POs or change financial data · execute text.

## OPS-2 update (2026-10-04)

- **Private channel discovery — root cause found and fixed.** Slack list/read methods (`conversations.list`, `users.conversations`, `conversations.info`, `conversations.history`) ignore arguments sent as a JSON body; the `types` filter was silently dropped, so only public channels came back and `#gso-agent-sandbox` (private) looked unlisted. Form-encoded and GET requests return it with `is_member=true`, matching the owner PowerShell result. `SlackClient.api` now sends those methods form-encoded (`FORM_ENCODED_METHODS`); `listChannels` paginates with cursors; `findChannel` resolves `#name` or an id. Scopes were sufficient (`channels:read`, `groups:read`); none were added.
- **Durable approvals.** `handleSlackInteraction(repos, interaction, { envStaffMap })` claims an `OpsExternalEventReceipt` per click (replay -> no-op), resolves identity from `OpsSlackStaffIdentity` first and the env JSON map second, then applies the decision through the intent engine. Events are receipted too. Works across processes once the Prisma repositories are configured.
- Live verification (run key `ops2-2026-10-04`, sandbox only): discovery lists the private sandbox channel as member, 8 cards posted once, replay duplicate=true, thread reply, Socket Mode hello.
