import db from "../db.server";
import {
  basenameOf,
  decodeIntakeOutcomes,
  encodeIntakeOutcomes,
  type IntakeOutcome,
} from "../lib/print-intake-routing.server";
import { INTAKE_REUSE_KEY_SEPARATOR, appendIntakeAudit, canonicalReviewReason, intakeRowJobId } from "../lib/print-intake-review.server";
import { applyRunSuffix, isClosedIntakeJobStatus } from "../lib/print-intake-routing.server";
import { recordRoutedPrintFile } from "../lib/production-job-source.server";

// Print Intake outcome recorder (13A.6G): the ONLY mutation in the intake
// flow, and it is narrow by construction — it appends one outcome record to
// the shop's rolling intake log (marker-namespaced JSON inside
// PrintLogAutoImportSetting.notes, cap 50, foreign notes text preserved) and,
// for routed files, writes one ProductionJobEvent on the shop-verified job.
// Idempotent: an identical fileName+hash+decision at the head of the log is
// acknowledged without writing again. Token-authenticated; shop-scoped;
// basenames only (never full local paths).
//
// Patch E (2026-11-18): a SUCCESSFUL routed report for a file the server
// itself matched and routed to this job also records the routed production
// print file on the job (one ProductionJobFile per file hash — see
// recordRoutedPrintFile). A plan alone never creates it, a failed / review /
// duplicate report never creates it, and it is never source artwork.

const DECISIONS = new Set(["routed", "needs_review", "duplicate", "failed"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// 2026-11-20 (reorder E2): the PrintIntake row a report is about. A file routed for one job and then
// again for a reorder item has two rows — the plain "<sha256>" row of the first job and a
// "<sha256>#<item id>" row per further item. A routed report names its job, so the row of THAT job is
// used (the item ticket breaks a tie inside one job); with no job the plain row is used, as before.
async function intakeRowForReport(shop: string, hash: string, jobId: string | null, itemTicket: string | null): Promise<any | null> {
  const plain = await db.printIntake.findUnique({ where: { shop_fileHashSha256: { shop, fileHashSha256: hash } } });
  if (!plain || !jobId) return plain;
  const wanted = String(itemTicket || "").toUpperCase();
  const ticketOk = (row: any) => !wanted || String(row.authoritativeTicket || "").toUpperCase() === wanted;
  if (intakeRowJobId(plain) === jobId && ticketOk(plain)) return plain;
  let reuse: any[] = [];
  try {
    const prefix = `${hash}${INTAKE_REUSE_KEY_SEPARATOR}`;
    const found = await db.printIntake.findMany({ where: { shop, fileHashSha256: { startsWith: prefix } }, orderBy: { updatedAt: "desc" }, take: 50 });
    reuse = (Array.isArray(found) ? found : []).filter((row: any) => String(row?.fileHashSha256 || "").startsWith(prefix) && intakeRowJobId(row) === jobId);
  } catch {
    reuse = [];
  }
  return reuse.find(ticketOk) || reuse[0] || plain;
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
  let job: { id: string; jobTicket: string | null; status?: string | null } | null = null;
  if (decision === "routed") {
    // Routed outcomes must reference a shop-verified job — a stale or
    // cross-shop jobId rejects the report outright (no partial writes).
    if (!jobId) return json({ ok: false, error: "routed outcome requires jobId." }, 400);
    job = await db.productionJob.findFirst({ where: { id: jobId, shop: setting.shop }, select: { id: true, jobTicket: true, status: true } });
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

  // Patch E: record the routed production print file on the existing job —
  // only for a delivery the server planned itself (the PrintIntake row for this
  // exact file is linked to THIS job with a press). Idempotent per job + hash,
  // so it runs before the duplicate-report shortcut and a repeat report can
  // only confirm it. Never blocks outcome recording.
  let printFile: { result: "created" | "updated" | "unchanged" | "failed" } | null = null;
  // 2026-11-20: true only when the server's own PrintIntake row links this exact file to this job.
  let serverPlanned = false;
  const routedHash = String(outcome.fileHash || "").toLowerCase();
  if (decision === "routed" && job && /^[0-9a-f]{64}$/.test(routedHash)) {
    try {
      const routedIntake = await intakeRowForReport(setting.shop, routedHash, job.id, outcome.itemTicket);
      const press = routedIntake?.printer === "mimaki" || routedIntake?.printer === "roland" ? routedIntake.printer : null;
      const routedName = String(routedIntake?.routedFilename || "").trim();
      if (routedIntake && routedIntake.status !== "rejected" && routedIntake.matchedProductionJobId === job.id && press && routedName) {
        serverPlanned = true;
        printFile = await recordRoutedPrintFile(db, {
          shop: setting.shop,
          jobId: job.id,
          jobTicket: job.jobTicket,
          fileHash: routedHash,
          originalFileName: routedIntake.originalFilename || fileName,
          routedFileName: routedName,
          machine: press,
          itemTicket: routedIntake.authoritativeTicket || outcome.itemTicket,
          itemId: (routedIntake as any).productionJobItemId || null,
        });
      }
    } catch {
      printFile = { result: "failed" };
    }
  }

  // Idempotency check before writing anything.
  const { outcomes } = decodeIntakeOutcomes(setting.notes);
  const head = outcomes[0];
  if (head && head.fileName === outcome.fileName && head.decision === outcome.decision && String(head.fileHash8 || "") === String(outcome.fileHash8 || "")) {
    return json({ ok: true, recorded: false, duplicateReport: true, printFile: printFile?.result ?? null });
  }

  const writes = [
    db.printLogAutoImportSetting.update({
      where: { id: setting.id },
      data: { notes: encodeIntakeOutcomes(setting.notes, outcome) },
    }),
  ];
  // Patch E: a repeat report for a file already recorded on the job (even one
  // that is no longer at the head of the log) adds no second "routed" event.
  // 2026-11-20: a finished / cancelled job is never written to by a report the server did not plan
  // itself (a stale or mistaken jobId). The outcome is still logged above; the job gets no event.
  const closedAndUnplanned = Boolean(job) && isClosedIntakeJobStatus(job?.status) && !serverPlanned;
  if (decision === "routed" && job && printFile?.result !== "unchanged" && !closedAndUnplanned) {
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

  // 15H.3: keep the authoritative PrintIntake disposition in sync with what
  // the AGENT actually did (best-effort; never blocks outcome recording).
  const fullHash = String(outcome.fileHash || "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(fullHash)) {
    try {
      const row = await intakeRowForReport(setting.shop, fullHash, decision === "routed" && job ? job.id : null, outcome.itemTicket);
      const audit = { at: new Date().toISOString(), actor: "print-intake-agent", action: `reported_${decision}`, reason: outcome.reason || null };
      // a routed report only ever confirms the row of ITS job (never another job's row of the same file)
      if (decision === "routed" && row && row.status !== "routed" && (!job || !intakeRowJobId(row) || intakeRowJobId(row) === job.id)) {
        await db.printIntake.update({ where: { id: row.id }, data: { status: "routed", rawParsedHints: appendIntakeAudit(row.rawParsedHints, audit) } });
      } else if ((decision === "needs_review" || decision === "failed") && row?.status !== "routed" && row?.status !== "rejected") {
        const reasonCode = canonicalReviewReason([outcome.reason || "", outcome.rule || ""]);
        const nextStatus = decision === "failed" ? "failed" : "review";
        if (row) {
          // 15H.5-L: a FAILED delivery advances the ATTEMPT counter exactly
          // once (never on polling scans — only when the agent reports an
          // actual failed routed delivery). The next delivery re-plans and
          // routes under __A{n+1}; revision/reprint are untouched.
          const attemptBump = decision === "failed"
            ? {
                attemptNumber: row.attemptNumber + 1,
                routedFilename: row.routedFilename
                  ? applyRunSuffix(row.routedFilename, { revision: row.revisionNumber, reprint: row.reprintNumber, attempt: row.attemptNumber + 1 })
                  : row.routedFilename,
              }
            : {};
          await db.printIntake.update({ where: { id: row.id }, data: { status: nextStatus, reviewReason: reasonCode, ...attemptBump, rawParsedHints: appendIntakeAudit(row.rawParsedHints, audit) } });
        } else {
          await db.printIntake.create({
            data: {
              shop: setting.shop,
              originalFilename: fileName,
              fileHashSha256: fullHash,
              status: nextStatus,
              reviewReason: reasonCode,
              printer: outcome.machine || null,
              routedFilename: outcome.ripName || null,
              authoritativeTicket: outcome.itemTicket || outcome.jobTicket || null,
              rawParsedHints: appendIntakeAudit(null, audit),
            },
          });
        }
      }
    } catch {
      // disposition sync must never break outcome recording
    }
  }
  return json({ ok: true, recorded: true, printFile: printFile?.result ?? null });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, decision, ...} to record a print-intake outcome." }),
    { headers: { "Content-Type": "application/json" } },
  );
