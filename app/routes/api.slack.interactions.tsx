// Slack HTTP endpoint (Events API + Interactivity) for the GSO operations
// agent (OPS-2: repository-backed, external-event receipts).
//
// Every request is signature-verified against SLACK_SIGNING_SECRET BEFORE the
// body is parsed; every event/interaction id is recorded as an external event
// receipt so Slack retries and double clicks are processed exactly once (across
// processes when the Prisma repositories are configured); only allow-listed
// block actions on known intent ids do anything, and only for Slack users
// mapped to ERP staff (repository first, SLACK_STAFF_MAP fallback). Message
// text is never executed. Returns 503 when Slack is not configured.

import { getOpsRepositories } from "../lib/ops/intent-store.server";
import { loadSlackEnv } from "../lib/slack/slack-client.server";
import { SLACK_ENV_VARS, parseStaffMap } from "../lib/slack/slack-config";
import { eventDedupKey, isSlackRetry, verifySlackSignature } from "../lib/slack/slack-security.server";
import { handleSlackInteraction, parseSlackInteraction } from "../lib/slack/slack-interactions";
import { decisionResultText } from "../lib/slack/slack-blocks";

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
    payload = contentType.includes("application/x-www-form-urlencoded") ? JSON.parse(new URLSearchParams(rawBody).get("payload") || "{}") : JSON.parse(rawBody || "{}");
  } catch {
    return json({ error: "bad_payload" }, 400);
  }
  if (payload?.type === "url_verification") return json({ challenge: payload.challenge });

  const repos = getOpsRepositories();
  const retry = isSlackRetry(request.headers);

  if (payload?.type === "event_callback") {
    const key = eventDedupKey(payload);
    if (key) {
      const receipt = await repos.events.claim({ source: "slack", externalId: key, kind: "event" });
      if (!receipt.first) return json({ ok: true, duplicate: true, retry: retry.num });
      await repos.events.complete(receipt.receipt.id, `read-only:${payload.event?.type ?? "event"}`);
    }
    // app_mention / message events are READ ONLY: no text is ever executed.
    return json({ ok: true, received: payload.event?.type ?? "event" });
  }

  const parsed = parseSlackInteraction(payload);
  if (!parsed.ok) return json({ ok: false, ignored: parsed.reason });
  const result = await handleSlackInteraction(repos, parsed.interaction, { envStaffMap: parseStaffMap(env[SLACK_ENV_VARS.staffMap]) });
  if (!result.ok) return json({ response_type: "ephemeral", text: `:no_entry: Not applied — ${result.reason}` });
  if (result.kind === "open") return json({ ok: true });
  if (result.kind === "replay") return json({ ok: true, duplicate: true, retry: retry.num });
  const intent = await repos.intents.getById(result.intentId);
  return json({ response_type: "in_channel", replace_original: false, text: intent ? decisionResultText(intent, result.decision, result.approver, result.duplicate) : `Recorded ${result.decision} on ${result.intentId}` });
}
