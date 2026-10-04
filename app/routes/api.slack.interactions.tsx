// Slack HTTP endpoint (Events API + Interactivity) for the GSO operations
// agent. Every request is signature-verified against SLACK_SIGNING_SECRET
// BEFORE the body is parsed; retries and duplicate clicks are de-duplicated;
// only allow-listed block actions on known intent ids do anything, and only
// for Slack users mapped to ERP staff. Message text is never executed.
//
// Returns 503 when Slack is not configured on this deployment, so the route
// is inert on Render until the owner adds the secret.

import { getIntentStore } from "../lib/ops/intent-store.server";
import { loadSlackEnv } from "../lib/slack/slack-client.server";
import { SLACK_ENV_VARS, parseStaffMap } from "../lib/slack/slack-config";
import { SlackEventDeduper, eventDedupKey, interactionDedupKey, isSlackRetry, verifySlackSignature } from "../lib/slack/slack-security.server";
import { handleSlackInteraction, parseSlackInteraction } from "../lib/slack/slack-interactions";
import { decisionResultText } from "../lib/slack/slack-blocks";

const deduper = new SlackEventDeduper();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function loader() {
  return json({ ok: true, endpoint: "slack-interactions", methods: ["POST"], mode: "signature-verified" });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const env = loadSlackEnv();
  const signingSecret = env[SLACK_ENV_VARS.signingSecret];
  if (!signingSecret) return json({ error: "slack_not_configured" }, 503);

  const rawBody = await request.text();
  const verdict = verifySlackSignature({ signingSecret, timestamp: request.headers.get("x-slack-request-timestamp"), signature: request.headers.get("x-slack-signature"), rawBody });
  if (!verdict.ok) return json({ error: "invalid_signature", reason: verdict.reason }, 401);

  const contentType = request.headers.get("content-type") || "";
  let payload: any;
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(rawBody);
      payload = JSON.parse(form.get("payload") || "{}");
    } else {
      payload = JSON.parse(rawBody || "{}");
    }
  } catch {
    return json({ error: "bad_payload" }, 400);
  }

  // Events API handshake.
  if (payload?.type === "url_verification") return json({ challenge: payload.challenge });

  const retry = isSlackRetry(request.headers);
  const key = payload?.type === "block_actions" ? interactionDedupKey(payload) : eventDedupKey(payload);
  if (key && !deduper.first(key)) return json({ ok: true, duplicate: true, retry: retry.num });

  if (payload?.type === "event_callback") {
    // app_mention / message events are READ ONLY: no text is ever executed.
    return json({ ok: true, received: payload.event?.type ?? "event" });
  }

  const parsed = parseSlackInteraction(payload);
  if (!parsed.ok) return json({ ok: false, ignored: parsed.reason });
  const result = handleSlackInteraction(getIntentStore(), parsed.interaction, parseStaffMap(env[SLACK_ENV_VARS.staffMap]));
  if (!result.ok) return json({ response_type: "ephemeral", text: `:no_entry: Not applied — ${result.reason}` });
  if (result.kind === "open") return json({ ok: true });
  const intent = getIntentStore().getById(result.intentId);
  return json({ response_type: "in_channel", replace_original: false, text: intent ? decisionResultText(intent, result.decision, result.approver, result.duplicate) : `Recorded ${result.decision} on ${result.intentId}` });
}
