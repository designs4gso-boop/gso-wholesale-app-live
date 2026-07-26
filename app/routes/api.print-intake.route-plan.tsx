import db from "../db.server";
import {
  basenameOf,
  decideIntakeRoute,
  decideMachineFromFilename,
  eligibleJobsWhere,
  parseFilenamePrintHints,
  type IntakeJob,
} from "../lib/print-intake-routing.server";
import { createOrReusePrintIntakeJob } from "../lib/production-job-source.server";

// Print Intake plan endpoint. 13A.6G behavior preserved for MATCHED files
// (deterministic hierarchy, machine key only, no local paths). 15F.0J.5:
// an UNMATCHED file with a full SHA-256 and a deterministic printer/mode is
// no longer parked as needs_review — the endpoint AUTO-CREATES a controlled
// print-intake ProductionJob (advisory-locked authoritative ticket,
// idempotent on shop+hash) and returns a routeable plan carrying linkage
// warnings. Commercial/linkage review never blocks deterministic routing;
// true routing blockers (conflicting printer tokens, unsupported modes)
// still review. Token-authenticated; shop-scoped.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
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
  if (!fileName) return json({ ok: false, error: "Missing fileName." }, 400);
  const subfolder = basenameOf(String(body.subfolder || "").trim());

  const jobs = await db.productionJob.findMany({
    where: eligibleJobsWhere(setting.shop),
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: {
      id: true, jobTicket: true, customerName: true, company: true, status: true,
      artworkUrl: true, printFileUrl: true,
      items: {
        select: {
          id: true, itemTicket: true, ripJobName: true, suggestedFileName: true,
          productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true,
        },
      },
      files: { select: { fileName: true, originalFileName: true }, take: 20 },
    },
  });

  const intakeJobs: IntakeJob[] = jobs.map((job) => ({
    id: job.id,
    jobTicket: job.jobTicket,
    customerName: job.customerName,
    company: job.company,
    status: job.status,
    artworkUrl: job.artworkUrl,
    printFileUrl: job.printFileUrl,
    items: job.items,
    fileNames: job.files.flatMap((file) => [file.fileName, file.originalFileName || ""]).filter(Boolean),
  }));

  const plan = decideIntakeRoute({ fileName, subfolder, jobs: intakeJobs });
  const fileHash = String(body.fileHash || "").trim().toLowerCase();
  const fileSize = Math.max(0, Math.floor(Number(body.fileSize || 0)));
  const hasFullHash = /^[0-9a-f]{64}$/.test(fileHash);

  // Matched existing job: record/refresh the PrintIntake linkage (best-effort;
  // the plan itself is unchanged 13A.6G behavior).
  if (plan.decision === "route" && hasFullHash) {
    try {
      await db.printIntake.upsert({
        where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: fileHash } },
        update: { matchedProductionJobId: plan.jobId, authoritativeTicket: plan.itemTicket || plan.jobTicket, printer: plan.machine, routingRule: plan.rule, routedFilename: plan.ripName, status: "routed" },
        create: {
          shop: setting.shop,
          originalFilename: fileName,
          originalSubfolder: subfolder || null,
          fileHashSha256: fileHash,
          fileSize,
          status: "routed",
          matchedProductionJobId: plan.jobId,
          authoritativeTicket: plan.itemTicket || plan.jobTicket,
          printer: plan.machine,
          printMode: null,
          routingRule: plan.rule,
          routedFilename: plan.ripName,
          rawParsedHints: JSON.stringify({ matched: true, rule: plan.rule }),
        },
      });
    } catch {
      // linkage recording must never break routing (e.g. migration not yet applied)
    }
    return json({ ok: true, fileName, plan: { ...plan, autoCreated: false, matchedExisting: true } });
  }

  // 15F.0J.5-D: unmatched (or ambiguous-candidate) file — printer/mode from
  // SAFE filename hints. Deterministic -> auto-create + route; conflicts or
  // unsupported modes stay review (true routing blockers).
  const unmatchedReasons = ["no_deterministic_match"];
  const isUnmatched = plan.decision === "review" && plan.reasons.some((reason) => unmatchedReasons.includes(reason) || reason.includes("_not_found_in_eligible_jobs"));
  const isAmbiguousCandidates = plan.decision === "review" && plan.candidates.length > 1;
  if ((isUnmatched || isAmbiguousCandidates) && hasFullHash) {
    const machineDecision = decideMachineFromFilename(fileName);
    if (!machineDecision.machine) {
      return json({ ok: true, fileName, plan: { ...plan, reasons: [...plan.reasons, ...machineDecision.reasons], autoCreated: false } });
    }
    const hints = parseFilenamePrintHints(fileName);
    const linkageWarnings = [
      isAmbiguousCandidates
        ? "Ambiguous existing production candidates — production linkage needs review (routed to a controlled print-intake job meanwhile)."
        : "Commercial linkage pending: no quote/order/customer attached (link later from the Production Board).",
    ];
    try {
      const created = await createOrReusePrintIntakeJob(db, {
        shop: setting.shop,
        fileName,
        subfolder,
        fileHash,
        fileSize,
        machine: machineDecision.machine,
        machineRule: String(machineDecision.machineRule || "default_cmyk"),
        mode: machineDecision.mode,
        hints,
        reviewWarnings: linkageWarnings,
      });
      return json({
        ok: true,
        fileName,
        plan: {
          decision: "route",
          rule: "print_intake_auto_created",
          jobId: created.productionJobId,
          itemId: null,
          jobTicket: created.jobTicket,
          itemTicket: null,
          ripName: created.ripName,
          machine: machineDecision.machine,
          machineRule: machineDecision.machineRule,
          reasons: machineDecision.reasons,
          candidates: plan.candidates,
          autoCreated: created.created,
          matchedExisting: false,
          printIntakeId: created.printIntakeId,
          reviewWarnings: linkageWarnings,
        },
      });
    } catch (error) {
      // 15F.0J.5A: ticket/DB failure is a ROUTING BLOCKER — leave the file
      // for retry with an ACTIONABLE, credential-safe error code + message.
      const message = String((error as Error)?.message || error || "");
      const code = (error as any)?.gsoCode === "advisory_lock_failed" || /advisory_lock_failed|deserialize.*void/i.test(message)
        ? "advisory_lock_failed"
        : /unknown argument|unknown field|unknown arg/i.test(message)
          ? "schema_mismatch"
          : /printIntake/i.test(message)
            ? "print_intake_create_failed"
            : /unique constraint|p2002/i.test(message)
              ? "unique_conflict_recovered"
              : "production_job_create_failed";
      const safeMessage = message.replace(/postgres(ql)?:\/\/\S+/gi, "[redacted-connection]").slice(0, 200);
      return json({ ok: true, fileName, plan: { ...plan, reasons: [...plan.reasons, `${code}: ${safeMessage}`], errorCode: code, autoCreated: false } });
    }
  }
  return json({ ok: true, fileName, plan: { ...plan, autoCreated: false } });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, subfolder?} for a deterministic print-intake routing plan. Read-only." }),
    { headers: { "Content-Type": "application/json" } },
  );
