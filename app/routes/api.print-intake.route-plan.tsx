import db from "../db.server";
import {
  applyRunSuffix,
  basenameOf,
  buildIntakeMachineContext,
  decideIntakeMachine,
  decideIntakeRoute,
  eligibleJobsWhere,
  ripFileBaseName,
  type IntakeJob,
  type IntakeSiblingRow,
} from "../lib/print-intake-routing.server";
import { NEEDS_LINK_TO_JOB_REASON, appendIntakeAudit, canonicalReviewReason, readIntakeMeta } from "../lib/print-intake-review.server";

// Print Intake plan endpoint. 13A.6G behavior preserved for MATCHED files
// (deterministic hierarchy, machine key only, no local paths).
//
// Patch C (2026-11-18): this endpoint NEVER creates a ProductionJob. A file
// that cannot be deterministically matched to an EXISTING job gets a durable
// PrintIntake review row ("NEEDS REVIEW — LINK TO JOB"), no printer and no
// route. It waits in Incoming Print Files until a person assigns it to a real
// job; the assigned branch below then routes it. (The 15F.0J.5 auto-created
// "Unlinked (print intake)" job is gone.) Token-authenticated; shop-scoped.
//
// Patch B (2026-11-18): the press is decided by decideIntakeMachine — explicit
// ERP press, then explicit filename tag, then gloss / white anywhere on the
// job -> Roland, otherwise CMYK -> Mimaki. No load balancing. Sibling layer
// files of the same item / design (`_cmyk`, `_g`, `_w`) are read together so
// one physical job is never split across presses; conflicts go to review. A
// file that was already routed keeps the press it was sent to.
// Safety follow-up: white / gloss REQUIRE the Roland (an explicit Mimaki on
// such a job is a printer conflict), and a lone `_cmyk` layer on a job with no
// stated finish is held for print-mode confirmation rather than sent early.

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
  const fileHashEarly = String(body.fileHash || "").trim().toLowerCase();
  const hasFullHashEarly = /^[0-9a-f]{64}$/.test(fileHashEarly);
  // Patch B: known intake files for this shop, so the press is decided for the
  // whole job (sibling layers) rather than one file at a time. Read-only.
  let siblingRows: IntakeSiblingRow[] = [];
  try {
    siblingRows = await db.printIntake.findMany({
      where: { shop: setting.shop, status: { not: "rejected" } },
      orderBy: { updatedAt: "desc" },
      take: 500,
      select: { fileHashSha256: true, originalFilename: true, authoritativeTicket: true, matchedProductionJobId: true, printer: true, status: true },
    });
  } catch {
    siblingRows = []; // sibling lookup must never break the plan response
  }
  const machineContext = (jobId: string | null, jobItemCount: number, itemTicket: string | null, jobFileNames: string[] = []) =>
    buildIntakeMachineContext({ fileName, fileHash: fileHashEarly, jobId, jobItemCount, itemTicket, rows: siblingRows, jobFileNames });

  // 15H.3: server-authoritative disposition FIRST. A rejected hash never
  // re-plans; an owner-assigned hash routes deterministically to the exact
  // assigned job/item (never fuzzy, machine rules still authoritative).
  const existingIntake = hasFullHashEarly
    ? await db.printIntake.findUnique({ where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: fileHashEarly } } })
    : null;
  if (existingIntake?.status === "rejected") {
    return json({ ok: true, fileName, plan: { decision: "review", rule: null, reasons: ["rejected_by_owner"], candidates: [], autoCreated: false, rejected: true } });
  }
  if (existingIntake && existingIntake.matchedProductionJobId && (existingIntake.status === "assigned" || existingIntake.status === "retry_allowed")) {
    const assignedJob = await db.productionJob.findFirst({
      where: { id: existingIntake.matchedProductionJobId, shop: setting.shop, active: true },
      select: {
        id: true, jobTicket: true, status: true,
        items: { select: { id: true, itemTicket: true, ripJobName: true, suggestedFileName: true, productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true } },
      },
    });
    const meta = readIntakeMeta(existingIntake.rawParsedHints);
    const assignedItem = assignedJob
      ? assignedJob.items.find((item) => item.id === meta.assignedItemId)
        || assignedJob.items.find((item) => item.itemTicket && item.itemTicket === existingIntake.authoritativeTicket)
        || (assignedJob.items.length === 1 ? assignedJob.items[0] : null)
      : null;
    if (!assignedJob || !assignedItem) {
      await db.printIntake.update({
        where: { id: existingIntake.id },
        data: {
          status: "review",
          reviewReason: assignedJob ? "ambiguous_candidates" : "unknown_ticket",
          rawParsedHints: appendIntakeAudit(existingIntake.rawParsedHints, { at: new Date().toISOString(), actor: "route-plan", action: "assignment_unresolvable", reason: assignedJob ? "item_unresolved" : "job_missing_or_inactive" }),
        },
      });
      return json({ ok: true, fileName, plan: { decision: "review", rule: null, reasons: [assignedJob ? "assigned_item_unresolved" : "assigned_job_missing_or_inactive"], candidates: [], autoCreated: false } });
    }
    const machineDecision = decideIntakeMachine(assignedItem as any, fileName, machineContext(assignedJob.id, assignedJob.items.length, assignedItem.itemTicket));
    if (!machineDecision.machine) {
      // Safety follow-up: record WHY the assigned file is waiting so Incoming
      // Print Files shows it (status stays "assigned"; written once, not per poll).
      const heldReason = canonicalReviewReason(machineDecision.reasons);
      if (existingIntake.reviewReason !== heldReason) {
        try {
          await db.printIntake.update({
            where: { id: existingIntake.id },
            data: { reviewReason: heldReason, rawParsedHints: appendIntakeAudit(existingIntake.rawParsedHints, { at: new Date().toISOString(), actor: "route-plan", action: "assigned_but_not_routed", reason: heldReason }) },
          });
        } catch {
          // recording the reason must never break the plan response
        }
      }
      return json({ ok: true, fileName, plan: { decision: "review", rule: null, machine: null, reasons: ["assigned_but_machine_unresolved", ...machineDecision.reasons], candidates: [], autoCreated: false } });
    }
    const assignedRun = { revision: existingIntake.revisionNumber, reprint: existingIntake.reprintNumber, attempt: existingIntake.attemptNumber };
    const assignedRunDefault = assignedRun.revision === 1 && assignedRun.reprint === 0 && assignedRun.attempt === 1;
    const baseRipName = ripFileBaseName(assignedItem as any) || String(existingIntake.authoritativeTicket || assignedJob.jobTicket || "");
    const ripName = assignedRunDefault ? baseRipName : applyRunSuffix(baseRipName, assignedRun);
    await db.printIntake.update({
      where: { id: existingIntake.id },
      data: {
        status: "routed",
        printer: machineDecision.machine,
        routingRule: "assigned_by_owner",
        routedFilename: ripName,
        authoritativeTicket: assignedItem.itemTicket || assignedJob.jobTicket,
        rawParsedHints: appendIntakeAudit(existingIntake.rawParsedHints, { at: new Date().toISOString(), actor: "route-plan", action: "routed_via_owner_assignment" }),
      },
    });
    return json({
      ok: true,
      fileName,
      plan: {
        decision: "route",
        rule: "assigned_by_owner",
        jobId: assignedJob.id,
        itemId: assignedItem.id,
        jobTicket: assignedJob.jobTicket,
        itemTicket: assignedItem.itemTicket,
        ripName,
        machine: machineDecision.machine,
        machineRule: machineDecision.machineRule,
        reasons: ["owner_assignment", ...machineDecision.reasons],
        candidates: [],
        autoCreated: false,
        matchedExisting: true,
        printIntakeId: existingIntake.id,
      },
    });
  }

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

  const plan = decideIntakeRoute({ fileName, subfolder, jobs: intakeJobs, machineContextFor: (job, item) => machineContext(job.id, job.items.length, item.itemTicket, job.fileNames) });
  // Patch B: a file never alternates presses between polls — once this exact
  // file was routed against this job, it keeps the press it was sent to.
  if (plan.decision === "route" && existingIntake?.status === "routed" && existingIntake.matchedProductionJobId === plan.jobId && (existingIntake.printer === "mimaki" || existingIntake.printer === "roland")) {
    plan.machine = existingIntake.printer;
  }
  const fileHash = fileHashEarly;
  const fileSize = Math.max(0, Math.floor(Number(body.fileSize || 0)));
  const hasFullHash = hasFullHashEarly;

  // 15H.3-C: every review outcome with a full hash gets a DURABLE server-side
  // review object (idempotent on shop+hash) so the ERP queue and the agent's
  // disposition checks have authoritative truth. Never downgrades a routed row.
  const reviewShop = setting.shop;
  async function recordReviewRow(reasons: string[], extraAudit?: string, options: { skipIfUnchanged?: boolean } = {}) {
    if (!hasFullHash) return;
    const reasonCode = canonicalReviewReason(reasons);
    try {
      const current = await db.printIntake.findUnique({ where: { shop_fileHashSha256: { shop: reviewShop, fileHashSha256: fileHash } } });
      if (current?.status === "routed" || current?.status === "rejected") return;
      // Patch C idempotency: a repeat poll of a file already waiting for the same reason writes nothing.
      if (options.skipIfUnchanged && current?.status === "review" && current.reviewReason === reasonCode) return;
      const audit = { at: new Date().toISOString(), actor: "route-plan", action: extraAudit || "plan_reviewed", reason: reasonCode };
      if (current) {
        await db.printIntake.update({
          where: { id: current.id },
          data: { status: "review", reviewReason: reasonCode, rawParsedHints: appendIntakeAudit(current.rawParsedHints, audit) },
        });
      } else {
        await db.printIntake.create({
          data: {
            shop: reviewShop,
            originalFilename: fileName,
            originalSubfolder: subfolder || null,
            fileHashSha256: fileHash,
            fileSize,
            status: "review",
            reviewReason: reasonCode,
            rawParsedHints: appendIntakeAudit(JSON.stringify({ planReasons: reasons.slice(0, 10) }), audit),
          },
        });
      }
    } catch {
      // review-row recording must never break the plan response
    }
  }

  // Matched existing job: record/refresh the PrintIntake linkage (best-effort;
  // the plan itself is unchanged 13A.6G behavior).
  if (plan.decision === "route" && hasFullHash) {
    let routedRipName = plan.ripName;
    try {
      // 15H.5: run identity. Same hash re-planning keeps its stored counters
      // (attempt bumps happen at failed-delivery reports; reprint bumps at
      // the owner action). A NEW hash matching a ticket that already has
      // routed artwork is a REVISION — corrected artwork, R+1.
      const ticket = plan.itemTicket || plan.jobTicket;
      let run = { revision: 1, reprint: 0, attempt: 1 };
      if (existingIntake) {
        run = { revision: existingIntake.revisionNumber, reprint: existingIntake.reprintNumber, attempt: existingIntake.attemptNumber };
      } else if (ticket) {
        const prior = await db.printIntake.findFirst({
          where: { shop: setting.shop, authoritativeTicket: ticket, status: "routed", NOT: { fileHashSha256: fileHash } },
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
        });
        if (prior) run = { revision: prior.revisionNumber + 1, reprint: 0, attempt: 1 };
      }
      const runIsDefault = run.revision === 1 && run.reprint === 0 && run.attempt === 1;
      routedRipName = runIsDefault ? plan.ripName : applyRunSuffix(plan.ripName || "", run);
      await db.printIntake.upsert({
        where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: fileHash } },
        update: { matchedProductionJobId: plan.jobId, authoritativeTicket: ticket, printer: plan.machine, routingRule: plan.rule, routedFilename: routedRipName, status: "routed" },
        create: {
          shop: setting.shop,
          originalFilename: fileName,
          originalSubfolder: subfolder || null,
          fileHashSha256: fileHash,
          fileSize,
          status: "routed",
          matchedProductionJobId: plan.jobId,
          authoritativeTicket: ticket,
          printer: plan.machine,
          printMode: null,
          routingRule: plan.rule,
          routedFilename: routedRipName,
          revisionNumber: run.revision,
          reprintNumber: run.reprint,
          attemptNumber: run.attempt,
          rawParsedHints: JSON.stringify({ matched: true, rule: plan.rule, run }),
        },
      });
    } catch {
      // linkage recording must never break routing (e.g. migration not yet applied)
    }
    return json({ ok: true, fileName, plan: { ...plan, ripName: routedRipName, autoCreated: false, matchedExisting: true } });
  }

  // Patch C: unmatched (or ambiguous-candidate) file -> REVIEW, never a job.
  // No ProductionJob, no item, no printer, no route. The file stays where
  // staff put it and waits for "Assign to..." on Incoming Print Files.
  const isUnmatched = plan.decision === "review" && plan.reasons.some((reason) => reason === "no_deterministic_match" || reason.includes("_not_found_in_eligible_jobs"));
  const isAmbiguousCandidates = plan.decision === "review" && plan.candidates.length > 1;
  if (isUnmatched || isAmbiguousCandidates) {
    const reviewReasons = isAmbiguousCandidates ? plan.reasons : [...plan.reasons, NEEDS_LINK_TO_JOB_REASON];
    await recordReviewRow(reviewReasons, "needs_link_to_job", { skipIfUnchanged: true });
    return json({
      ok: true,
      fileName,
      plan: { ...plan, decision: "review", rule: null, machine: null, machineRule: null, ripName: null, jobId: null, itemId: null, reasons: reviewReasons, autoCreated: false, matchedExisting: false, needsLinkToJob: true },
    });
  }
  if (plan.decision === "review") await recordReviewRow(plan.reasons);
  return json({ ok: true, fileName, plan: { ...plan, autoCreated: false } });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, subfolder?} for a deterministic print-intake routing plan. Read-only." }),
    { headers: { "Content-Type": "application/json" } },
  );
