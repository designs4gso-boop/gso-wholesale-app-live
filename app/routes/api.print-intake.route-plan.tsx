import db from "../db.server";
import {
  applyRunSuffix,
  basenameOf,
  decideIntakeRoute,
  decideMachine,
  decideMachineFromFilename,
  eligibleJobsWhere,
  parseFilenamePrintHints,
  ripFileBaseName,
  type IntakeJob,
} from "../lib/print-intake-routing.server";
import { createOrReusePrintIntakeJob } from "../lib/production-job-source.server";
import { appendIntakeAudit, canonicalReviewReason, readIntakeMeta } from "../lib/print-intake-review.server";

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
  const fileHashEarly = String(body.fileHash || "").trim().toLowerCase();
  const hasFullHashEarly = /^[0-9a-f]{64}$/.test(fileHashEarly);

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
    const machineDecision = decideMachine(assignedItem as any, fileName);
    if (!machineDecision.machine) {
      return json({ ok: true, fileName, plan: { decision: "review", rule: null, reasons: ["assigned_but_machine_unresolved", ...machineDecision.reasons], candidates: [], autoCreated: false } });
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

  const plan = decideIntakeRoute({ fileName, subfolder, jobs: intakeJobs });
  const fileHash = fileHashEarly;
  const fileSize = Math.max(0, Math.floor(Number(body.fileSize || 0)));
  const hasFullHash = hasFullHashEarly;

  // 15H.3-C: every review outcome with a full hash gets a DURABLE server-side
  // review object (idempotent on shop+hash) so the ERP queue and the agent's
  // disposition checks have authoritative truth. Never downgrades a routed row.
  const reviewShop = setting.shop;
  async function recordReviewRow(reasons: string[], extraAudit?: string) {
    if (!hasFullHash) return;
    const reasonCode = canonicalReviewReason(reasons);
    try {
      const current = await db.printIntake.findUnique({ where: { shop_fileHashSha256: { shop: reviewShop, fileHashSha256: fileHash } } });
      if (current?.status === "routed" || current?.status === "rejected") return;
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

  // 15F.0J.5-D: unmatched (or ambiguous-candidate) file — printer/mode from
  // SAFE filename hints. Deterministic -> auto-create + route; conflicts or
  // unsupported modes stay review (true routing blockers).
  const unmatchedReasons = ["no_deterministic_match"];
  const isUnmatched = plan.decision === "review" && plan.reasons.some((reason) => unmatchedReasons.includes(reason) || reason.includes("_not_found_in_eligible_jobs"));
  const isAmbiguousCandidates = plan.decision === "review" && plan.candidates.length > 1;
  if ((isUnmatched || isAmbiguousCandidates) && hasFullHash) {
    const machineDecision = decideMachineFromFilename(fileName);
    if (!machineDecision.machine) {
      const reviewReasons = [...plan.reasons, ...machineDecision.reasons];
      await recordReviewRow(reviewReasons);
      return json({ ok: true, fileName, plan: { ...plan, reasons: reviewReasons, autoCreated: false } });
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
      await recordReviewRow([`${code}: ${safeMessage}`], "auto_create_failed");
      return json({ ok: true, fileName, plan: { ...plan, reasons: [...plan.reasons, `${code}: ${safeMessage}`], errorCode: code, autoCreated: false } });
    }
  }
  if (plan.decision === "review") await recordReviewRow(plan.reasons);
  return json({ ok: true, fileName, plan: { ...plan, autoCreated: false } });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, subfolder?} for a deterministic print-intake routing plan. Read-only." }),
    { headers: { "Content-Type": "application/json" } },
  );
