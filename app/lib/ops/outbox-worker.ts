// GSO Operations Agent Platform — outbox worker (OPS-2). Pure: repositories
// and handlers are injected; nothing here imports Prisma, Slack or OpenAI.
//
// Lifecycle: PENDING -> PROCESSING (claimed by one worker) -> COMPLETED
//            | FAILED (retry at nextAttemptAt, bounded backoff) | DEAD (manual review)
//
// Every handler runs INSIDE the policy: the intent referenced by the message
// must be APPROVED (or the message must not be intent-bound), consequential
// actions respect the execution kill switch, and a completed message is never
// re-executed. The worker is NOT scheduled or deployed in this release.

import { executeIntent, isConsequential, type ActionIntent } from "./action-intents";
import type { ActionType } from "./autonomy";
import type { OpsRepositories, OutboxMessage } from "./repositories";
import type { OpsRuntimeConfig } from "./runtime-config";

export const OUTBOX_WORKER_VERSION = "outbox-worker/1.1.0-2026-10-04";

/**
 * WORKER SAFETY CEILING (Stage 5, 2026-10-04). The background worker may
 * never execute a consequential action, whatever the execution switch says
 * and however the intent was approved. Production job movement, customer
 * messages, POs, invoices, refunds, cost/price changes, dispatch, QC and
 * shipping records require a HUMAN execution path (today: the owner's
 * explicit hub action through requestProductionTransition for job moves).
 * Inventory, material, Shopify-order and financial mutations have no
 * ActionType at all and therefore no worker path.
 */
export const WORKER_FORBIDDEN_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "move_production_job", "dispatch_to_machine", "record_qc_result", "mark_shipped", "record_final_art_approval",
  "send_customer_notification", "send_purchase_order", "send_invoice", "refund_or_void", "change_cost_or_price",
  "override_canonical_blocker", "post_slack_external",
]);

export function workerMayExecute(actionType: ActionType): boolean {
  return !WORKER_FORBIDDEN_ACTIONS.has(actionType) && !isConsequential(actionType);
}

export type HandlerContext = { repos: OpsRepositories; config: OpsRuntimeConfig; now: Date; workerId: string; message: OutboxMessage };

/** A deterministic side-effect executor. It receives the APPROVED intent when the message is intent-bound. */
export type OutboxHandler = (ctx: HandlerContext, intent: ActionIntent | null) => Promise<{ externalReference?: string | null }>;

export type OutboxHandlers = Record<string, OutboxHandler>;

export type WorkerOptions = { workerId?: string; batchSize?: number; now?: Date; staleAfterMs?: number; backoffBaseMs?: number; backoffMaxMs?: number };

export type WorkerReport = {
  version: string;
  workerId: string;
  claimed: number;
  completed: string[];
  retried: string[];
  dead: string[];
  skipped: Array<{ id: string; reason: string }>;
  releasedStale: number;
};

export function backoffMs(attempt: number, baseMs = 30_000, maxMs = 30 * 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Process one batch. Safe to call from any scheduler; concurrent workers never claim the same message. */
export async function processOutboxBatch(repos: OpsRepositories, config: OpsRuntimeConfig, handlers: OutboxHandlers, options: WorkerOptions = {}): Promise<WorkerReport> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `worker-${now.getTime().toString(36)}`;
  const report: WorkerReport = { version: OUTBOX_WORKER_VERSION, workerId, claimed: 0, completed: [], retried: [], dead: [], skipped: [], releasedStale: 0 };
  report.releasedStale = await repos.outbox.releaseStale(new Date(now.getTime() - (options.staleAfterMs ?? 10 * 60_000)));
  const batch = await repos.outbox.claim(workerId, now, options.batchSize ?? 10);
  report.claimed = batch.length;

  for (const message of batch) {
    const handler = handlers[message.type];
    if (!handler) { await repos.outbox.markFailed(message.id, `no handler for type "${message.type}"`, null, now); report.dead.push(message.id); continue; }
    try {
      let intent: ActionIntent | null = null;
      if (message.intentId) {
        intent = await repos.intents.getById(message.intentId);
        if (!intent) throw new Error(`intent ${message.intentId} not found`);
        if (intent.status === "COMPLETED") { await repos.outbox.markCompleted(message.id, intent.externalReference, now); report.skipped.push({ id: message.id, reason: "intent already completed" }); continue; }
        if (intent.status === "CANCELLED" || intent.status === "FAILED") { await repos.outbox.markFailed(message.id, `intent is ${intent.status}`, null, now); report.dead.push(message.id); continue; }
        if (!workerMayExecute(intent.actionType)) {
          // Never retried: a human execution path is required. Kept for manual review.
          await repos.outbox.markFailed(message.id, `worker may not execute consequential action ${intent.actionType}; requires explicit human execution`, null, now);
          report.dead.push(message.id);
          continue;
        }
        if (intent.status !== "APPROVED") { await repos.outbox.markFailed(message.id, `intent is ${intent.status}; waiting for approval`, new Date(now.getTime() + backoffMs(message.attempts, options.backoffBaseMs, options.backoffMaxMs)), now); report.retried.push(message.id); continue; }
        // Execute THROUGH the intent engine so the kill switch, single-execution and audit all apply.
        const ctx: HandlerContext = { repos, config, now, workerId, message };
        const result = await executeIntent(repos.intents, intent.id, (approved) => handler(ctx, approved), { now, gate: { executionEnabled: config.executionEnabled }, actor: { type: "system", id: workerId } });
        if (result.ok) { await repos.outbox.markCompleted(message.id, result.intent.externalReference, now); report.completed.push(message.id); continue; }
        if (result.blockedByKillSwitch) { await repos.outbox.markFailed(message.id, result.reason, new Date(now.getTime() + backoffMs(message.attempts, options.backoffBaseMs, options.backoffMaxMs)), now); report.retried.push(message.id); continue; }
        throw new Error(result.reason);
      }
      const outcome = await handler({ repos, config, now, workerId, message }, null);
      await repos.outbox.markCompleted(message.id, outcome.externalReference ?? null, now);
      report.completed.push(message.id);
    } catch (error: any) {
      const text = String(error?.message || error);
      if (message.attempts >= message.maxAttempts) { await repos.outbox.markFailed(message.id, text, null, now); report.dead.push(message.id); }
      else { await repos.outbox.markFailed(message.id, text, new Date(now.getTime() + backoffMs(message.attempts, options.backoffBaseMs, options.backoffMaxMs)), now); report.retried.push(message.id); }
    }
  }
  return report;
}
