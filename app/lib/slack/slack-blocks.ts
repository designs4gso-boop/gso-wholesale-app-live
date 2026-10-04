// GSO Slack integration — Block Kit builders. Client-safe, pure.
//
// Every message that asks for a decision carries the ActionIntent id in the
// button VALUE and a fixed ACTION ID from SLACK_ACTION_IDS. Slack text is
// never executed; the only things a click can do are the five decisions the
// interaction handler understands (approve / reject / request changes / hold
// / release), applied to a LOCAL action intent. "Open in ERP" is a URL.

import type { ActionIntent } from "../ops/action-intents";
import { redactForLog } from "../ops/untrusted-text";

export const SLACK_ACTION_IDS = {
  approve: "gso_intent_approve",
  reject: "gso_intent_reject",
  requestChanges: "gso_intent_request_changes",
  hold: "gso_intent_hold",
  release: "gso_intent_release",
  openErp: "gso_open_erp",
} as const;

export type SlackActionId = (typeof SLACK_ACTION_IDS)[keyof typeof SLACK_ACTION_IDS];

export type Block = Record<string, unknown>;

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } });
const divider = (): Block => ({ type: "divider" });

export function erpUrl(base: string | undefined, path: string): string {
  const root = String(base || "https://gso-wholesale-app-live.onrender.com").replace(/\/$/, "");
  return `${root}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** The decision row for an intent. Value = intent id only (never free text). */
export function decisionActions(intent: Pick<ActionIntent, "id" | "autonomyLevel">, erpPath?: string, erpBase?: string): Block {
  const elements: Block[] = [
    { type: "button", action_id: SLACK_ACTION_IDS.approve, text: { type: "plain_text", text: intent.autonomyLevel === "OWNER_REQUIRED" ? "APPROVE (owner)" : "APPROVE" }, style: "primary", value: intent.id, confirm: { title: { type: "plain_text", text: "Approve this intent?" }, text: { type: "mrkdwn", text: `Intent \`${intent.id}\` will be APPROVED under your Slack identity. Approvals are audited.` }, confirm: { type: "plain_text", text: "Approve" }, deny: { type: "plain_text", text: "Cancel" } } },
    { type: "button", action_id: SLACK_ACTION_IDS.reject, text: { type: "plain_text", text: "REJECT" }, style: "danger", value: intent.id },
    { type: "button", action_id: SLACK_ACTION_IDS.requestChanges, text: { type: "plain_text", text: "REQUEST CHANGES" }, value: intent.id },
  ];
  if (erpPath) elements.push({ type: "button", action_id: SLACK_ACTION_IDS.openErp, text: { type: "plain_text", text: "OPEN IN ERP" }, url: erpUrl(erpBase, erpPath) });
  return { type: "actions", block_id: `gso_intent_${intent.id}`, elements };
}

function prefix(sandboxRedirected: boolean, destination: string): Block[] {
  return sandboxRedirected ? [context(`:test_tube: *SANDBOX* — would post to \`${destination}\`. No production action was taken.`)] : [];
}

export type IntentCardInput = {
  title: string;
  intent: Pick<ActionIntent, "id" | "actionType" | "agentId" | "autonomyLevel" | "entityType" | "entityId" | "reason" | "status" | "idempotencyKey">;
  facts: Array<[string, string]>;
  destination: string;
  sandboxRedirected: boolean;
  erpPath?: string;
  erpBase?: string;
  footer?: string;
};

/** Generic approval card. */
export function intentCard(input: IntentCardInput): Block[] {
  const factsText = input.facts.map(([k, v]) => `*${k}:* ${redactForLog(v)}`).join("\n");
  const blocks: Block[] = [
    ...prefix(input.sandboxRedirected, input.destination),
    header(input.title),
    section(factsText || "_no details_"),
    context(`agent \`${input.intent.agentId}\` · action \`${input.intent.actionType}\` · level \`${input.intent.autonomyLevel}\` · intent \`${input.intent.id}\` · status \`${input.intent.status}\``),
  ];
  if (input.intent.status === "AWAITING_APPROVAL") blocks.push(decisionActions(input.intent, input.erpPath, input.erpBase));
  if (input.footer) blocks.push(context(input.footer));
  return blocks;
}

export function agentOnlineBlocks(input: { version: string; agentsActive: number; agentsDraft: number; sandboxRedirected: boolean }): Block[] {
  return [
    ...prefix(input.sandboxRedirected, "agent_approvals"),
    header("GSO Operations agent online"),
    section(`Platform \`${input.version}\` · ${input.agentsActive} agents ACTIVE, ${input.agentsDraft} DRAFT · Slack sandbox mode.`),
    context("Read-only tonight: no production writes, no customer messages, no money actions. QuickBooks DEFERRED."),
  ];
}

export function newLeadBlocks(input: { company: string; family: string; quantity: string; classification: string; readiness: string; missing: string[]; sandboxRedirected: boolean; intent?: IntentCardInput["intent"]; erpPath?: string }): Block[] {
  const blocks: Block[] = [
    ...prefix(input.sandboxRedirected, "sales_leads"),
    header(`New lead — ${input.company}`),
    section(`*Family:* ${input.family}\n*Quantity:* ${input.quantity}\n*Classification:* ${input.classification}\n*Quote readiness:* \`${input.readiness}\`${input.missing.length ? `\n*Missing:* ${input.missing.join(", ")}` : ""}`),
    context("Lead Manager (deterministic). Staff review required before any customer reply."),
  ];
  if (input.intent && input.intent.status === "AWAITING_APPROVAL") blocks.push(decisionActions(input.intent, input.erpPath));
  return blocks;
}

export function reportBlocks(input: { title: string; lines: string[]; sandboxRedirected: boolean; caveat?: string }): Block[] {
  return [
    ...prefix(input.sandboxRedirected, "management_reports"),
    header(input.title),
    section(input.lines.map((l) => `• ${l}`).join("\n") || "_no data_"),
    context(input.caveat || "ERP-owned data only. Not cash collected. QuickBooks financials DEFERRED."),
    divider(),
  ];
}

export function exceptionBlocks(input: { code: string; summary: string; entity: string; nextAction: string; sandboxRedirected: boolean; destination: string }): Block[] {
  return [
    ...prefix(input.sandboxRedirected, input.destination),
    header(`Exception — ${input.code}`),
    section(`*Entity:* ${input.entity}\n*What:* ${redactForLog(input.summary)}\n*Next action:* ${input.nextAction}`),
    context("Exception Manager. Blockers are never bypassed by an agent."),
  ];
}

/** Thread reply after a decision. */
export function decisionResultText(intent: Pick<ActionIntent, "id" | "status" | "actionType">, decision: string, byName: string, duplicate: boolean): string {
  if (duplicate) return `:repeat: \`${intent.id}\` — ${decision} already recorded (duplicate click ignored). Status \`${intent.status}\`.`;
  return `:white_check_mark: \`${intent.id}\` (${intent.actionType}) — *${decision}* by ${byName}. Status \`${intent.status}\`.`;
}
