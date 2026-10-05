// Stage 5 — authenticated internal trigger for the durable outbox worker.
//
// Intended for a future owner-created Render Cron Job (or another trusted
// scheduler) to POST on an interval. NOT scheduled by anything in this repo.
//
//   * fails closed (503) unless GSO_OPS_WORKER_TOKEN (>= 32 chars) is set,
//   * requires `Authorization: Bearer <token>` with a timing-safe compare (401),
//   * accepts NO payload: the request body is ignored; the only thing a caller
//     can do is ask the existing worker to process its own durable outbox,
//   * one batch at a time per process (409 when busy), durable claims across
//     processes, idempotent handlers, policy/autonomy and the execution switch
//     enforced inside the worker, consequential actions never executed,
//   * returns sanitized counts only (no payloads, no PII, no secrets).
//
// GET returns sanitized diagnostics without processing anything (same auth).

import { getOpsRepositories } from "../lib/ops/intent-store.server";
import { readOpsRuntimeConfig } from "../lib/ops/runtime-config";
import { authenticateWorkerRequest, createWorkerHandlersV1, runWorkerOnce, workerDiagnostics } from "../lib/ops/worker-runtime.server";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function loader({ request }: { request: Request }) {
  const auth = authenticateWorkerRequest(request.headers.get("authorization"));
  if (!auth.ok) return json({ ok: false, error: auth.reason }, auth.status);
  const diagnostics = await workerDiagnostics(getOpsRepositories(), readOpsRuntimeConfig());
  return json({ ok: true, diagnostics });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const auth = authenticateWorkerRequest(request.headers.get("authorization"));
  if (!auth.ok) return json({ ok: false, error: auth.reason }, auth.status);
  const config = readOpsRuntimeConfig();
  const repos = getOpsRepositories();
  const result = await runWorkerOnce(repos, config, createWorkerHandlersV1(), { batchSize: 10 });
  if (!result.ok) return json({ ok: false, error: "busy" }, 409);
  const r = result.report;
  return json({ ok: true, workerId: r.workerId, claimed: r.claimed, completed: r.completed.length, retried: r.retried.length, dead: r.dead.length, skipped: r.skipped.length, releasedStale: r.releasedStale, executionEnabled: config.executionEnabled });
}
