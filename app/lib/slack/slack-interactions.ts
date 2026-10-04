// GSO Slack integration — interaction handling (OPS-2: async, repository-backed).
//
// A Slack click can do exactly one of five things to exactly one ActionIntent
// in the repository: approve, reject, request changes, hold, release. The
// intent id comes from the button VALUE (never from message text), the
// decision from the ACTION ID allow-list, and the approver from the Slack
// user id mapped to an ERP staff identity (repository first, env JSON map as
// fallback). Unmapped users cannot approve anything. Every interaction is
// recorded as an external event receipt so a Slack retry or double click is
// processed exactly once, across processes when the Prisma repositories are
// in use.

import { decideIntent, type ApprovalDecision } from "../ops/action-intents";
import type { OpsRepositories } from "../ops/repositories";
import { scanUntrustedText } from "../ops/untrusted-text";
import { SLACK_ACTION_IDS } from "./slack-blocks";
import { resolveStaffIdentity, type StaffIdentity } from "./slack-config";
import { interactionDedupKey } from "./slack-dedupe";

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
  /** Stable external id for idempotency (user, message, action, value). */
  externalId: string;
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

export function parseSlackInteraction(payload: any): ParseResult {
  if (!payload || payload.type !== "block_actions") return { ok: false, reason: `Unsupported interaction type "${payload?.type ?? "none"}".` };
  const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
  if (!action?.action_id) return { ok: false, reason: "No action in payload." };
  if (!(action.action_id in ALLOWED)) return { ok: false, reason: `Action id "${action.action_id}" is not on the allowlist.` };
  const intentId = String(action.value ?? "").trim();
  if (action.action_id !== SLACK_ACTION_IDS.openErp && !/^ai_[0-9a-f]{8}_\d+$/.test(intentId)) return { ok: false, reason: "Button value is not a valid intent id." };
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
      externalId: interactionDedupKey(payload) ?? `interaction:${payload.trigger_id ?? "unknown"}`,
    },
  };
}

export type HandleResult =
  | { ok: true; kind: "decision"; decision: ApprovalDecision; intentId: string; status: string; duplicate: boolean; approver: string }
  | { ok: true; kind: "open"; intentId: string }
  | { ok: true; kind: "replay"; intentId: string | null }
  | { ok: false; reason: string; intentId: string | null };

export type HandleOptions = { envStaffMap?: Record<string, StaffIdentity>; now?: Date; skipReceipt?: boolean };

/**
 * Apply a parsed interaction. Order: external-event receipt (replay -> no-op)
 * -> identity (repository, then env map) -> decision via the intent engine.
 */
export async function handleSlackInteraction(repos: OpsRepositories, interaction: ParsedInteraction, options: HandleOptions = {}): Promise<HandleResult> {
  const now = options.now ?? new Date();
  const decision = ALLOWED[interaction.actionId];
  if (decision === "OPEN") return { ok: true, kind: "open", intentId: interaction.intentId };

  const receipt = options.skipReceipt ? null : await repos.events.claim({ source: "slack", externalId: interaction.externalId, kind: "interaction", now });
  if (receipt && !receipt.first) return { ok: true, kind: "replay", intentId: interaction.intentId };

  const fromRepo = await repos.slackIdentities.resolve(interaction.slackUserId);
  const who = fromRepo ? { mapped: true as const, staffId: fromRepo.staffId, name: fromRepo.name, role: fromRepo.role } : resolveStaffIdentity(options.envStaffMap ?? {}, interaction.slackUserId);
  if (!who.mapped) {
    if (receipt) await repos.events.fail(receipt.receipt.id, "unmapped slack user");
    return { ok: false, reason: `Slack user ${interaction.slackUserId || "(unknown)"} is not mapped to an ERP staff identity; decisions from unmapped users are refused.`, intentId: interaction.intentId };
  }
  const scan = scanUntrustedText(interaction.comment);
  const comment = interaction.comment ? `${interaction.comment.slice(0, 300)}${scan.instructionLike ? ` [untrusted text flagged: ${scan.flags.join(",")}]` : ""}` : undefined;
  const result = await decideIntent(repos.intents, interaction.intentId, decision, { type: who.role === "owner" ? "owner" : "staff", id: who.staffId, name: who.name, role: who.role, source: `slack:${interaction.slackUserId}` }, comment, now);
  if (!result.ok) {
    if (receipt) await repos.events.fail(receipt.receipt.id, result.reason);
    return { ok: false, reason: result.reason, intentId: interaction.intentId };
  }
  if (receipt) await repos.events.complete(receipt.receipt.id, `${decision}:${result.intent.status}`);
  return { ok: true, kind: "decision", decision, intentId: interaction.intentId, status: result.intent.status, duplicate: result.duplicate, approver: who.name };
}
