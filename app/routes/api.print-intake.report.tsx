import db from "../db.server";
import {
  basenameOf,
  decodeIntakeOutcomes,
  encodeIntakeOutcomes,
  type IntakeOutcome,
} from "../lib/print-intake-routing.server";

// Print Intake outcome recorder (13A.6G): the ONLY mutation in the intake
// flow, and it is narrow by construction — it appends one outcome record to
// the shop's rolling intake log (marker-namespaced JSON inside
// PrintLogAutoImportSetting.notes, cap 50, foreign notes text preserved) and,
// for routed files, writes one ProductionJobEvent on the shop-verified job.
// Idempotent: an identical fileName+hash+decision at the head of the log is
// acknowledged without writing again. Token-authenticated; shop-scoped;
// basenames only (never full local paths).

const DECISIONS = new Set(["routed", "needs_review", "duplicate", "failed"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function safeText(value: unknown, max = 160): string | null {
  const text = String(value ?? "").trim().slice(0, max);
  return text || null;
}

export async function action({ request }: { request: Request }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400);
  }
  const token = String(body.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing upload token." }, 401);
  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken: token } });
  if (!setting || !setting.enabled) return json({ ok: false, error: "Invalid or disabled upload token." }, 403);

  const fileName = basenameOf(String(body.fileName || "").trim());
  const decision = String(body.decision || "").trim();
  if (!fileName) return json({ ok: false, error: "Missing fileName." }, 400);
  if (!DECISIONS.has(decision)) return json({ ok: false, error: "decision must be routed|needs_review|duplicate|failed." }, 400);

  const jobId = safeText(body.jobId, 40);
  let job: { id: string; jobTicket: string | null } | null = null;
  if (decision === "routed") {
    // Routed outcomes must reference a shop-verified job — a stale or
    // cross-shop jobId rejects the report outright (no partial writes).
    if (!jobId) return json({ ok: false, error: "routed outcome requires jobId." }, 400);
    job = await db.productionJob.findFirst({ where: { id: jobId, shop: setting.shop }, select: { id: true, jobTicket: true } });
    if (!job) return json({ ok: false, error: "Production job not found in this shop — nothing recorded." }, 400);
  }

  const outcome: IntakeOutcome = {
    at: new Date().toISOString(),
    fileName,
    decision: decision as IntakeOutcome["decision"],
    rule: safeText(body.rule, 40),
    reason: safeText(body.reason, 200),
    jobTicket: safeText(body.jobTicket, 40),
    itemTicket: safeText(body.itemTicket, 40),
    ripName: safeText(body.ripName, 130),
    machine: safeText(body.machine, 20),
    fileHash8: safeText(body.fileHash8, 8),
    fileHash: safeText(body.fileHash, 64) || null, // 15F.0J.4 full SHA-256
  };

  // Idempotency check before writing anything.
  const { outcomes } = decodeIntakeOutcomes(setting.notes);
  const head = outcomes[0];
  if (head && head.fileName === outcome.fileName && head.decision === outcome.decision && String(head.fileHash8 || "") === String(outcome.fileHash8 || "")) {
    return json({ ok: true, recorded: false, duplicateReport: true });
  }

  const writes = [
    db.printLogAutoImportSetting.update({
      where: { id: setting.id },
      data: { notes: encodeIntakeOutcomes(setting.notes, outcome) },
    }),
  ];
  if (decision === "routed" && job) {
    writes.push(
      db.productionJobEvent.create({
        data: {
          shop: setting.shop,
          jobId: job.id,
          eventType: "print_file_routed",
          message: `Print file routed by intake agent: ${fileName} -> ${outcome.ripName || "?"} (${outcome.machine || "?"}${outcome.itemTicket ? `, item ${outcome.itemTicket}` : ""}).`,
          oldValue: null,
          newValue: outcome.ripName,
          createdBy: "print-intake-agent",
        },
      }) as never,
    );
  }
  await db.$transaction(writes);
  return json({ ok: true, recorded: true });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, decision, ...} to record a print-intake outcome." }),
    { headers: { "Content-Type": "application/json" } },
  );
