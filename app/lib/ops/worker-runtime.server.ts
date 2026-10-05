// Stage 5 — durable worker runtime (server-only). NOT scheduled, NOT deployed.
//
// Wraps the existing outbox worker (processOutboxBatch) with:
//   * the v1 handler allow-list (only safe internal work),
//   * a process-level mutex so two overlapping triggers never run a batch at
//     the same time (the repository claim is still the cross-process guard),
//   * caller authentication for the internal HTTP trigger (shared secret in
//     GSO_OPS_WORKER_TOKEN, timing-safe compare, fail closed when absent),
//   * sanitized diagnostics (counts and last errors only; no payloads, no PII,
//     no secrets) for the Operations Hub and the trigger response.
//
// The worker can never execute a consequential action: WORKER_FORBIDDEN_ACTIONS
// in outbox-worker.ts dead-letters such messages regardless of the execution
// switch. Production job movement stays exclusively on the owner's explicit
// hub action through requestProductionTransition().

import crypto from "node:crypto";

import { readOpsRuntimeConfig, type OpsRuntimeConfig } from "./runtime-config";
import { WORKER_FORBIDDEN_ACTIONS, processOutboxBatch, type OutboxHandlers, type WorkerReport } from "./outbox-worker";
import type { OpsRepositories, OutboxMessage } from "./repositories";
import { SlackClient, loadSlackEnv } from "../slack/slack-client.server";
import { SLACK_ENV_VARS, type SlackDestination } from "../slack/slack-config";

export const WORKER_RUNTIME_VERSION = "worker-runtime/1.0.0-2026-10-04";
export const WORKER_TOKEN_ENV = "GSO_OPS_WORKER_TOKEN";
/** No scheduler exists in this repository; a Render Cron Job (owner-created) would call the trigger. */
export const WORKER_SCHEDULED = false as const;

/** v1 handler allow-list. Anything else dead-letters as "no handler". */
export const WORKER_HANDLER_TYPES_V1 = ["ops.noop", "slack.post"] as const;

export function createWorkerHandlersV1(slackEnv = loadSlackEnv()): OutboxHandlers {
  const slack = new SlackClient(slackEnv);
  return {
    /** Deterministic bookkeeping marker; used to prove the loop end-to-end without side effects. */
    "ops.noop": async (ctx) => ({ externalReference: `noop:${ctx.message.id}` }),
    /**
     * Internal Slack notification. Refuses outside sandbox-only mode (first
     * release). Destination is a logical name; the client resolves it and the
     * sandbox redirect applies. Text/blocks come from the ERP-built message
     * payload, never from an external caller.
     */
    "slack.post": async (ctx) => {
      if (String(slackEnv[SLACK_ENV_VARS.sandboxOnly] ?? "").trim().toLowerCase() !== "true") throw new Error("slack.post refused: SLACK_SANDBOX_ONLY is not true (first worker release is sandbox-only)");
      const destination = String(ctx.message.payload.destination ?? "agent_approvals") as SlackDestination;
      const result = await slack.postBlocks({ destination, text: String(ctx.message.payload.text ?? "GSO operations notice"), blocks: Array.isArray(ctx.message.payload.blocks) ? (ctx.message.payload.blocks as any[]) : undefined, idempotencyKey: `outbox:${ctx.message.idempotencyKey}` });
      if (!result.ok) throw new Error(`slack.post failed: ${result.error}`);
      return { externalReference: `slack:${result.channel}:${result.ts}` };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Authentication for the internal trigger
 * ------------------------------------------------------------------ */

export type WorkerAuth = { ok: true } | { ok: false; status: 401 | 503; reason: "token_not_configured" | "missing_bearer" | "invalid_token" };

export function authenticateWorkerRequest(authorizationHeader: string | null, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): WorkerAuth {
  const expected = String(env[WORKER_TOKEN_ENV] ?? "").trim();
  if (expected.length < 32) return { ok: false, status: 503, reason: "token_not_configured" }; // fail closed; short tokens are treated as unset
  const m = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader ?? "").trim());
  if (!m) return { ok: false, status: 401, reason: "missing_bearer" };
  const a = Buffer.from(m[1].trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, reason: "invalid_token" };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Diagnostics (sanitized)
 * ------------------------------------------------------------------ */

export type WorkerDiagnostics = {
  version: string;
  scheduled: false;
  authConfigured: boolean;
  executionEnabled: boolean;
  repository: "memory" | "prisma";
  handlers: readonly string[];
  forbiddenActions: string[];
  outbox: { pending: number; claimableNow: number; processing: number; retrying: number; completed: number; dead: number };
  dead: Array<{ id: string; type: string; attempts: number; lastError: string | null; createdAt: string }>;
  retrying: Array<{ id: string; type: string; attempts: number; nextAttemptAt: string; lastError: string | null }>;
  busy: boolean;
  lastRun: (WorkerReport & { at: string }) | null;
};

let inFlight = false;
let lastRun: (WorkerReport & { at: string }) | null = null;

export async function workerDiagnostics(repos: OpsRepositories, config: OpsRuntimeConfig = readOpsRuntimeConfig(), env: Record<string, string | undefined> = process.env as Record<string, string | undefined>, now = new Date()): Promise<WorkerDiagnostics> {
  const all = await repos.outbox.list();
  const by = (s: OutboxMessage["status"]) => all.filter((m) => m.status === s);
  const due = (m: OutboxMessage) => new Date(m.nextAttemptAt).getTime() <= now.getTime();
  return {
    version: WORKER_RUNTIME_VERSION,
    scheduled: WORKER_SCHEDULED,
    authConfigured: String(env[WORKER_TOKEN_ENV] ?? "").trim().length >= 32,
    executionEnabled: config.executionEnabled,
    repository: config.repository,
    handlers: WORKER_HANDLER_TYPES_V1,
    forbiddenActions: Array.from(WORKER_FORBIDDEN_ACTIONS),
    outbox: { pending: by("PENDING").length, claimableNow: all.filter((m) => (m.status === "PENDING" || m.status === "FAILED") && due(m)).length, processing: by("PROCESSING").length, retrying: by("FAILED").length, completed: by("COMPLETED").length, dead: by("DEAD").length },
    dead: by("DEAD").slice(0, 20).map((m) => ({ id: m.id, type: m.type, attempts: m.attempts, lastError: m.lastError ? m.lastError.slice(0, 200) : null, createdAt: m.createdAt })),
    retrying: by("FAILED").slice(0, 20).map((m) => ({ id: m.id, type: m.type, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lastError: m.lastError ? m.lastError.slice(0, 200) : null })),
    busy: inFlight,
    lastRun,
  };
}

/* ------------------------------------------------------------------ *
 * One guarded batch
 * ------------------------------------------------------------------ */

export type WorkerRunResult = { ok: true; report: WorkerReport } | { ok: false; reason: "busy" };

export async function runWorkerOnce(repos: OpsRepositories, config: OpsRuntimeConfig, handlers: OutboxHandlers, options: { workerId?: string; batchSize?: number; now?: Date } = {}): Promise<WorkerRunResult> {
  if (inFlight) return { ok: false, reason: "busy" };
  inFlight = true;
  try {
    const report = await processOutboxBatch(repos, config, handlers, { workerId: options.workerId ?? `http-${(options.now ?? new Date()).getTime().toString(36)}`, batchSize: options.batchSize ?? 10, now: options.now });
    lastRun = { ...report, at: (options.now ?? new Date()).toISOString() };
    return { ok: true, report };
  } finally {
    inFlight = false;
  }
}

/** Test hook: reset module state. */
export function _resetWorkerRuntimeForTests() { inFlight = false; lastRun = null; }
