// Stage 3 (2026-10-04) — durable Slack approval bridge TEST.
//
// The smallest safe path that proves: Prisma ActionIntent -> real sandbox
// approval card -> signed Slack click -> mapped owner -> durable APPROVED ->
// append-only audit -> replay protection, WITHOUT any production action.
//
// Everything here reuses the existing platform: proposeIntent/validateIntent,
// the repository boundary, intentCard + SLACK_ACTION_IDS, the Slack client's
// destination resolution and idempotent posting, and the live
// /api/slack/interactions endpoint for the click. The intent is SYNTHETIC
// (entity OPS-SANDBOX-TEST-NO-ERP-WRITE). This module never imports the
// transition executor, the outbox worker or Prisma job models; a test pins
// that. Client-safe: the Slack poster and repositories are injected.

import { proposeIntent, validateIntent, type ActionIntent, type AuditEvent } from "./action-intents";
import type { OpsRepositories } from "./repositories";
import type { OpsRuntimeConfig } from "./runtime-config";
import type { Block } from "../slack/slack-blocks";
import { intentCard } from "../slack/slack-blocks";
import { SLACK_ENV_VARS, type SlackDestination, type SlackDestinationResolution, type SlackEnv } from "../slack/slack-config";

export const SANDBOX_APPROVAL_TEST_VERSION = "sandbox-approval-test/1.0.0-2026-10-04";
export const SANDBOX_TEST_ENTITY_ID = "OPS-SANDBOX-TEST-NO-ERP-WRITE";
export const SANDBOX_TEST_AGENT_ID = "production_planner";
export const SANDBOX_TEST_ACTION = "move_production_job" as const;
export const SANDBOX_TEST_REASON = "Stage 3 durable Slack approval plumbing test. No ERP job mutation permitted.";

/** Minimal Slack poster contract (the real SlackClient satisfies it; tests use a fake). */
export interface SandboxSlackPoster {
  destination(destination: SlackDestination): SlackDestinationResolution;
  postBlocks(input: { destination: SlackDestination; text: string; blocks?: Block[]; idempotencyKey?: string }): Promise<{ ok: true; duplicate: boolean; channel: string; ts: string; sandboxRedirected: boolean } | { ok: false; error: string }>;
}

export type GateResult = { ok: boolean; reasons: string[]; checks: Record<string, boolean> };

/** ALL must hold or the test refuses: no intent, no Slack post. */
export function sandboxApprovalTestGate(config: OpsRuntimeConfig, slackEnv: SlackEnv): GateResult {
  const checks = {
    prismaRepository: config.repository === "prisma",
    sandboxOnlyTrue: String(slackEnv[SLACK_ENV_VARS.sandboxOnly] ?? "").trim().toLowerCase() === "true",
    executionDisabled: config.executionEnabled === false,
    botTokenPresent: Boolean(slackEnv[SLACK_ENV_VARS.botToken]?.trim()),
    signingSecretPresent: Boolean(slackEnv[SLACK_ENV_VARS.signingSecret]?.trim()),
    testChannelPresent: Boolean(slackEnv[SLACK_ENV_VARS.testChannel]?.trim()),
  };
  const reasons: string[] = [];
  if (!checks.prismaRepository) reasons.push("GSO_OPS_REPOSITORY is not prisma (memory mode cannot prove durability)");
  if (!checks.sandboxOnlyTrue) reasons.push("SLACK_SANDBOX_ONLY is not explicitly true");
  if (!checks.executionDisabled) reasons.push("GSO_AGENT_EXECUTION_ENABLED is true — refusing to create approval tests while execution is live");
  if (!checks.botTokenPresent) reasons.push("SLACK_BOT_TOKEN absent");
  if (!checks.signingSecretPresent) reasons.push("SLACK_SIGNING_SECRET absent");
  if (!checks.testChannelPresent) reasons.push("SLACK_TEST_CHANNEL absent");
  return { ok: reasons.length === 0, reasons, checks };
}

export type SandboxTestInput = {
  repos: OpsRepositories;
  config: OpsRuntimeConfig;
  slackEnv: SlackEnv;
  slack: SandboxSlackPoster;
  /** Server-generated per page render; the same key never creates a second intent. */
  runKey: string;
  requestedBy: { id: string; name?: string };
  erpBase?: string;
  now?: Date;
};

export type SandboxTestResult =
  | { ok: true; intent: ActionIntent; duplicateIntent: boolean; slack: { channel: string; ts: string; duplicate: boolean; sandboxRedirected: boolean } }
  | { ok: false; stage: "gate" | "runKey" | "intent" | "validate" | "destination" | "slack"; reasons: string[]; intentId?: string };

export async function createSandboxApprovalTest(input: SandboxTestInput): Promise<SandboxTestResult> {
  const gate = sandboxApprovalTestGate(input.config, input.slackEnv);
  if (!gate.ok) return { ok: false, stage: "gate", reasons: gate.reasons };
  const runKey = String(input.runKey ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runKey)) return { ok: false, stage: "runKey", reasons: ["run key must be server-generated (8-80 url-safe chars)"] };
  const now = input.now ?? new Date();

  const proposed = await proposeIntent(input.repos.intents, {
    actionType: SANDBOX_TEST_ACTION,
    agentId: SANDBOX_TEST_AGENT_ID,
    entityType: "job",
    entityId: SANDBOX_TEST_ENTITY_ID,
    payload: { targetStatus: "printing", sandboxTest: true, runKey },
    reason: SANDBOX_TEST_REASON,
    idempotencyKey: `sandbox-approval-test:${runKey}`,
    actor: { type: "staff", id: input.requestedBy.id, name: input.requestedBy.name, source: "ops-hub:sandbox-approval-test" },
    now,
  });
  if (!proposed.ok) return { ok: false, stage: "intent", reasons: [proposed.reason] };
  if (!proposed.duplicate) {
    const v = await validateIntent(input.repos.intents, proposed.intent.id, { type: "system", id: "ops-hub" }, now);
    if (!v.ok) return { ok: false, stage: "validate", reasons: [v.reason], intentId: proposed.intent.id };
  }
  const intent = (await input.repos.intents.getById(proposed.intent.id))!;
  if (intent.autonomyLevel !== "APPROVAL_REQUIRED" || (intent.status !== "AWAITING_APPROVAL" && intent.status !== "APPROVED")) {
    return { ok: false, stage: "validate", reasons: [`unexpected intent state ${intent.status}/${intent.autonomyLevel}`], intentId: intent.id };
  }

  // Logical destination "production" MUST resolve to the sandbox channel.
  const target = input.slack.destination("production");
  const testChannel = String(input.slackEnv[SLACK_ENV_VARS.testChannel]).replace(/^#/, "");
  const resolvedName = String(target.channel ?? "").replace(/^#/, "");
  if (!target.channel || !target.sandboxRedirected || resolvedName !== testChannel) {
    return { ok: false, stage: "destination", reasons: [`destination did not resolve to the sandbox channel (${target.reason})`], intentId: intent.id };
  }

  const blocks = intentCard({
    title: "Stage 3 Durable Approval Test",
    intent,
    facts: [
      ["Intent ID", intent.id],
      ["Action type", intent.actionType],
      ["Agent", intent.agentId],
      ["Synthetic entity", `${intent.entityType}:${intent.entityId} (no real job)`],
      ["Execution status", "OFF — GSO_AGENT_EXECUTION_ENABLED=false; no ERP mutation possible"],
      ["Requested by", input.requestedBy.name || input.requestedBy.id],
    ],
    destination: "production",
    sandboxRedirected: true,
    erpPath: "/app/erp/ops-hub",
    erpBase: input.erpBase,
    footer: "SANDBOX TEST. Approving records a durable APPROVED state and an audit row only. Nothing executes.",
  });
  const posted = await input.slack.postBlocks({ destination: "production", text: `SANDBOX Stage 3 durable approval test ${intent.id}`, blocks, idempotencyKey: `sandbox-approval-test:${intent.id}` });
  if (!posted.ok) return { ok: false, stage: "slack", reasons: [posted.error], intentId: intent.id };

  if (!posted.duplicate) await recordSlackCardPosted(input.repos, intent, posted, now);
  return { ok: true, intent, duplicateIntent: proposed.duplicate, slack: { channel: posted.channel, ts: posted.ts, duplicate: posted.duplicate, sandboxRedirected: posted.sandboxRedirected } };
}

/** Append-only trace of a Slack card post on the intent's audit trail (no payload, no secrets). Shared by Stage 3 and Stage 4. */
export async function recordSlackCardPosted(repos: OpsRepositories, intent: ActionIntent, posted: { channel: string; ts: string }, now: Date) {
  const rec = { at: now.toISOString(), actor: { type: "system" as const, id: "ops-hub" }, event: "slack_card_posted", from: intent.status, to: intent.status, detail: `${posted.channel} ${posted.ts}` };
  intent.audit.push(rec);
  await repos.intents.save(intent);
  const audit: AuditEvent = {
    id: `${intent.id}:slack:${posted.ts}`, intentId: intent.id, idempotencyKey: intent.idempotencyKey, agentId: intent.agentId, agentVersion: intent.agentVersion,
    provider: intent.provider, model: intent.model, entityType: intent.entityType, entityId: intent.entityId, actionType: intent.actionType, reason: intent.reason,
    payloadKeys: Object.keys(intent.payload), autonomyLevel: intent.autonomyLevel, previousStatus: intent.status, newStatus: intent.status, event: "slack_card_posted",
    actor: rec.actor, approver: intent.approvedBy, at: rec.at, executionResult: null, externalReference: `slack:${posted.channel}:${posted.ts}`, error: null, detail: rec.detail,
  };
  await repos.intents.appendAudit(audit);
}

/** Hub grouping (shared with the loader so the test can pin it). */
export function groupIntentsForHub<T extends { status: string; actionType: ActionIntent["actionType"] }>(intents: T[], config: OpsRuntimeConfig, isConsequential: (a: ActionIntent["actionType"]) => boolean) {
  return {
    pending: intents.filter((i) => i.status === "AWAITING_APPROVAL"),
    blocked: intents.filter((i) => i.status === "APPROVED" && isConsequential(i.actionType) && !config.executionEnabled),
    failed: intents.filter((i) => i.status === "FAILED"),
    completed: intents.filter((i) => i.status === "COMPLETED"),
  };
}
