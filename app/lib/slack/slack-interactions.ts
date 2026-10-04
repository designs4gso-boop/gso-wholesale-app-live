// GSO Slack integration — interaction handling. Client-safe, pure.
//
// A Slack click can do exactly one of five things to exactly one LOCAL
// ActionIntent: approve, reject, request changes, hold, release. The intent
// id comes from the button VALUE (never from message text), the decision from
// the ACTION ID allowlist, and the approver from the Slack user id mapped to
// an ERP staff identity. Unmapped users cannot approve anything. No message
// text is ever interpreted as a command.

import { decideIntent, type ActionIntentStore, type ApprovalDecision } from "../ops/action-intents";
import { SLACK_ACTION_IDS } from "./slack-blocks";
import { resolveStaffIdentity, type StaffIdentity } from "./slack-config";
import { scanUntrustedText } from "../ops/untrusted-text";

export type ParsedInteraction = {
  type: "block_actions";
  actionId: string;
  intentId: string;
  slackUserId: string;
  slackUserName: string;
  channel: string | null;
  messageTs: string | null;
  responseUrl: string | null;
  /** Free text (e.g. from a modal) is UNTRUSTED and only ever stored as a comment. */
  comment: string | null;
};

export type ParseResult = { ok: true; interaction: ParsedInteraction } | { ok: false; reason: string };

const ALLOWED: Record<string, ApprovalDecision | "OPEN"> = {
  [SLACK_ACTION_IDS.approve]: "APPROVE",
  [SLACK_ACTION_IDS.reject]: "REJECT",
  [SLACK_ACTION_IDS.requestChanges]: "REQUEST_CHANGES",
  [SLACK_ACTION_IDS.hold]: "HOLD",
  [SLACK_ACTION_IDS.release]: "RELEASE",
  [SLACK_ACTION_IDS.openErp]: "OPEN",
};

/** Parse a Slack interactivity payload (already JSON-decoded). */
export function parseSlackInteraction(payload: any): ParseResult {
  if (!payload || payload.type !== "block_actions") return { ok: false, reason: `Unsupported interaction type "${payload?.type ?? "none"}".` };
  const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
  if (!action?.action_id) return { ok: false, reason: "No action in payload." };
  if (!(action.action_id in ALLOWED)) return { ok: false, reason: `Action id "${action.action_id}" is not on the allowlist.` };
  const intentId = String(action.value ?? "").trim();
  if (action.action_id !== SLACK_ACTION_IDS.openErp && !/^ai_[0-9a-f]{8}_\d+$/.test(intentId)) {
    return { ok: false, reason: "Button value is not a valid intent id." };
  }
  return {
    ok: true,
    interaction: {
      type: "block_actions",
      actionId: action.action_id,
      intentId,
      slackUserId: String(payload.user?.id ?? ""),
      slackUserName: String(payload.user?.username ?? payload.user?.name ?? ""),
      channel: payload.channel?.id ?? payload.container?.channel_id ?? null,
      messageTs: payload.container?.message_ts ?? payload.message?.ts ?? null,
      responseUrl: payload.response_url ?? null,
      comment: typeof payload.state?.comment === "string" ? payload.state.comment : null,
    },
  };
}

export type HandleResult =
  | { ok: true; kind: "decision"; decision: ApprovalDecision; intentId: string; status: string; duplicate: boolean; approver: string }
  | { ok: true; kind: "open"; intentId: string }
  | { ok: false; reason: string; intentId: string | null };

/**
 * Apply a parsed interaction to the local intent store. The approver must be
 * a mapped staff/owner identity; comments are stored as untrusted data and
 * scanned so an injected instruction is visible in the audit.
 */
export function handleSlackInteraction(
  store: ActionIntentStore,
  interaction: ParsedInteraction,
  staffMap: Record<string, StaffIdentity>,
  now = new Date(),
): HandleResult {
  const decision = ALLOWED[interaction.actionId];
  if (decision === "OPEN") return { ok: true, kind: "open", intentId: interaction.intentId };
  const who = resolveStaffIdentity(staffMap, interaction.slackUserId);
  if (!who.mapped) {
    return { ok: false, reason: `Slack user ${interaction.slackUserId || "(unknown)"} is not mapped to an ERP staff identity; decisions from unmapped users are refused.`, intentId: interaction.intentId };
  }
  const scan = scanUntrustedText(interaction.comment);
  const comment = interaction.comment
    ? `${interaction.comment.slice(0, 300)}${scan.instructionLike ? ` [untrusted text flagged: ${scan.flags.join(",")}]` : ""}`
    : undefined;
  const result = decideIntent(store, interaction.intentId, decision, { type: who.role === "owner" ? "owner" : "staff", id: who.staffId, name: who.name, role: who.role, source: `slack:${interaction.slackUserId}` }, comment, now);
  if (!result.ok) return { ok: false, reason: result.reason, intentId: interaction.intentId };
  return { ok: true, kind: "decision", decision, intentId: interaction.intentId, status: result.intent.status, duplicate: result.duplicate, approver: who.name };
}
