import liveDb from "../db.server";
import { readOnlyIntakeDb } from "../lib/print-intake-dry-run.server";
import {
  ITEM_TICKET_RE,
  applyRunSuffix,
  basenameOf,
  buildIntakeMachineContext,
  decideIntakeMachine,
  decideIntakeRoute,
  disambiguatedRoutedName,
  eligibleJobsWhere,
  isClosedIntakeJobStatus,
  revisionReorderProofHold,
  ripFileBaseName,
  staffFileKey,
  stripRunSuffix,
  type IntakeJob,
  type IntakeSiblingRow,
} from "../lib/print-intake-routing.server";
import { INTAKE_REUSE_KEY_SEPARATOR, NEEDS_LINK_TO_JOB_REASON, ROUTED_NAME_COLLISION_REASON, appendIntakeAudit, canonicalReviewReason, intakeContentHash, intakeReuseKey, intakeRowJobId, readIntakeMeta } from "../lib/print-intake-review.server";
import { reprintNumberOfRun } from "../lib/production-run";

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
// Patch A (2026-11-18): `dryRun: true` plans against a read-only database
// facade — the same decision is returned and NOTHING is written.
// Patch D (2026-11-18): a file inside a folder whose name BEGINS with an
// existing job ticket inherits that job (priority after a ticket in the
// filename, before stored names). A multi-item job with no certain item goes
// to review (link to item); nothing is matched from other folder text.
// Safety follow-up: white / gloss REQUIRE the Roland (an explicit Mimaki on
// such a job is a printer conflict), and a lone `_cmyk` layer on a job with no
// stated finish is held for print-mode confirmation rather than sent early.
//
// 2026-11-20 (lineage fixes):
//  - ROUTED NAME: two different staff files of one item never share a routed
//    name. The same staff file saved again is a revision (R+1); a different
//    file whose sanitized name is already held gets a short deterministic mark.
//    A file that was already issued a name keeps exactly that name on a retry.
//  - OPEN REPRINT / REMAKE: a new or corrected file routed while a reprint or
//    remake run is open on the item carries THAT run's token (…__R2-P1-A1), so
//    its press result is counted on the open run, not on the original.
//  - REORDER, SAME FILE: a file already routed for one job is never re-pointed
//    at another. Routing the identical file for a reorder item writes a second
//    row keyed "<sha256>#<item id>"; the earlier job's row is not touched.
//  - REORDER WITH REVISION: the file is held until the job's proof is approved.
//  - CLOSED JOBS: no matching rule and no pending assignment attaches a file to
//    a completed / cancelled job (an explicit reprint request is the exception).

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function action({ request }: { request: Request }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Body must be JSON." }, 400);
  }
  // Patch A (2026-11-18): TRUE read-only dry run. With `dryRun: true` the whole
  // plan runs against a read-only facade of the database — every read works,
  // every write (review rows, linkage, audit, assigned-file updates) is
  // suppressed on the SERVER and counted. The response carries dryRun / wrote
  // so the agent can prove nothing was written.
  const dryRun = body.dryRun === true;
  const readOnly = dryRun ? readOnlyIntakeDb(liveDb) : null;
  const db = readOnly ? readOnly.client : liveDb;
  const json = (data: unknown, status = 200) =>
    jsonResponse(readOnly ? { ...(data as Record<string, unknown>), dryRun: true, wrote: false, suppressedWrites: readOnly.suppressedWrites() } : data, status);
  const token = String(body.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing upload token." }, 401);
  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken: token } });
  if (!setting || !setting.enabled) return json({ ok: false, error: "Invalid or disabled upload token." }, 403);

  const fileName = basenameOf(String(body.fileName || "").trim());
  if (!fileName) return json({ ok: false, error: "Missing fileName." }, 400);
  const subfolder = basenameOf(String(body.subfolder || "").trim());
  // Patch D: names of the other artwork files in the same ticket job folder
  // (basenames only). They only ever inform the press decision for sibling
  // LAYERS of the same design — they are never a matching signal.
  const folderFiles = (Array.isArray(body.folderFiles) ? (body.folderFiles as unknown[]) : [])
    .slice(0, 60)
    .map((name) => basenameOf(String(name || "").trim()).slice(0, 200))
    .filter(Boolean);
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
    buildIntakeMachineContext({ fileName, fileHash: fileHashEarly, jobId, jobItemCount, itemTicket, rows: siblingRows, jobFileNames: [...jobFileNames, ...folderFiles] });

  // 15H.3: server-authoritative disposition FIRST. A rejected hash never
  // re-plans; an owner-assigned hash routes deterministically to the exact
  // assigned job/item (never fuzzy, machine rules still authoritative).
  const existingIntake = hasFullHashEarly
    ? await db.printIntake.findUnique({ where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: fileHashEarly } } })
    : null;
  if (existingIntake?.status === "rejected") {
    return json({ ok: true, fileName, plan: { decision: "review", rule: null, reasons: ["rejected_by_owner"], candidates: [], autoCreated: false, rejected: true } });
  }
  // 2026-11-20 (E2): the same file may also hold REUSE rows — one per further item it was routed for
  // (key "<sha256>#<item id>"). They are only looked up when the plain row exists.
  let reuseRows: any[] = [];
  if (existingIntake) {
    try {
      const prefix = `${fileHashEarly}${INTAKE_REUSE_KEY_SEPARATOR}`;
      const found = await db.printIntake.findMany({ where: { shop: setting.shop, fileHashSha256: { startsWith: prefix } }, orderBy: { updatedAt: "desc" }, take: 50 });
      reuseRows = (Array.isArray(found) ? found : []).filter((row: any) => String(row?.fileHashSha256 || "").startsWith(prefix) && row.status !== "rejected");
    } catch {
      reuseRows = []; // a failed lookup falls back to the plain row only
    }
  }
  const rowsOfThisFile: any[] = [...(existingIntake ? [existingIntake] : []), ...reuseRows];

  // 2026-11-20: run identity + routed name for a file that is about to be routed for `item`.
  //   ownRow WITH a routed name  -> exactly that name and its stored counters (retry-safe; attempt /
  //                                 reprint bumps were written by the report and the reprint action);
  //   otherwise a NEW name       -> revision of the same staff file (R+1), or the plain name, or the
  //                                 plain name with a deterministic mark when a DIFFERENT file holds it.
  //   A reprint / remake run that is OPEN on the item gives the file that run's P number.
  const namingShop = setting.shop;
  type RoutedNaming = { ok: true; ripName: string; run: { revision: number; reprint: number; attempt: number }; fresh: boolean } | { ok: false; reason: string };
  async function nameRoutedFile(ownRow: any | null, item: { id: string; itemTicket: string | null; ripJobName: string | null; suggestedFileName: string | null }, ticket: string | null, computedBase: string): Promise<RoutedNaming> {
    const bareBase = ripFileBaseName(item as any).toLowerCase();
    const storedBase = ownRow?.routedFilename ? stripRunSuffix(String(ownRow.routedFilename)) : "";
    if (ownRow && storedBase && (!bareBase || storedBase.toLowerCase().startsWith(bareBase))) {
      const run = { revision: ownRow.revisionNumber, reprint: ownRow.reprintNumber, attempt: ownRow.attemptNumber };
      const runIsDefault = run.revision === 1 && run.reprint === 0 && run.attempt === 1;
      return { ok: true, ripName: runIsDefault ? storedBase : applyRunSuffix(storedBase, run), run, fresh: false };
    }
    const attempt = Math.max(1, Number(ownRow?.attemptNumber) || 1);
    if (!ticket) return { ok: true, ripName: computedBase, run: { revision: 1, reprint: 0, attempt }, fresh: true };
    const found = await db.printIntake.findMany({ where: { shop: namingShop, authoritativeTicket: ticket }, orderBy: { updatedAt: "desc" }, take: 200 });
    const others = (Array.isArray(found) ? found : []).filter((row: any) =>
      row && row.id !== ownRow?.id && String(row.authoritativeTicket || "").toUpperCase() === ticket.toUpperCase() && intakeContentHash(row.fileHashSha256) !== fileHashEarly);
    // the open reprint / remake run of this item (structured run rows first; a pending re-route for older data)
    let openReprint = 0;
    let hasRunRows = false;
    try {
      const runs = ((await db.productionRun.findMany({ where: { shop: namingShop, itemId: item.id } })) || []).filter((run: any) => run && run.itemId === item.id);
      hasRunRows = runs.length > 0;
      const open = runs.filter((run: any) => run.status === "open" && run.kind !== "original");
      openReprint = Math.max(0, ...open.map((run: any) => Number(reprintNumberOfRun(run)) || 0));
    } catch {
      openReprint = 0;
    }
    // Items reprinted before run rows existed (2026-11-19) have none: a layer still waiting to be re-routed is the sign.
    if (!hasRunRows) openReprint = Math.max(0, ...others.filter((row: any) => row.status === "retry_allowed").map((row: any) => Number(row.reprintNumber) || 0));
    const myKey = staffFileKey(fileName);
    const sameStaffFile = others
      .filter((row: any) => ["routed", "retry_allowed", "assigned"].includes(String(row.status)) && row.routedFilename && staffFileKey(row.originalFilename) === myKey)
      .sort((a: any, b: any) => (b.revisionNumber - a.revisionNumber) || (new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()));
    if (sameStaffFile.length) {
      const prior = sameStaffFile[0];
      const run = { revision: prior.revisionNumber + 1, reprint: openReprint, attempt };
      return { ok: true, ripName: applyRunSuffix(stripRunSuffix(String(prior.routedFilename)), run), run, fresh: true };
    }
    const held = new Set(others.filter((row: any) => row.routedFilename).map((row: any) => stripRunSuffix(String(row.routedFilename)).toLowerCase()));
    let base = computedBase;
    for (let salt = 0; held.has(base.toLowerCase()); salt += 1) {
      if (salt > 5) return { ok: false, reason: ROUTED_NAME_COLLISION_REASON };
      base = disambiguatedRoutedName(computedBase, fileName, salt);
    }
    const run = { revision: 1, reprint: openReprint, attempt };
    const runIsDefault = run.reprint === 0 && run.attempt === 1;
    return { ok: true, ripName: runIsDefault ? base : applyRunSuffix(base, run), run, fresh: true };
  }

  // An owner assignment / release / reprint request waiting on ANY row of this file is served first.
  const pendingRow: any | null = rowsOfThisFile.find((row) => row.matchedProductionJobId && (row.status === "assigned" || row.status === "retry_allowed")) || null;
  if (pendingRow) {
    const existingIntake = pendingRow; // this branch works on the pending row only
    const assignedJob = await db.productionJob.findFirst({
      where: { id: existingIntake.matchedProductionJobId, shop: setting.shop, active: true },
      select: {
        id: true, jobTicket: true, status: true, proofStatus: true,
        items: { select: { id: true, itemTicket: true, ripJobName: true, suggestedFileName: true, productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true, reorderArtworkMode: true } },
      },
    });
    const meta = readIntakeMeta(pendingRow.rawParsedHints);
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
    // 2026-11-20: a pending row never attaches a file to a finished / cancelled job, and never prints a
    // revision-reorder file before its proof is approved. The one exception to the closed-job rule is an
    // explicit reprint / remake request (the reprint action stamped a reprint number on the row).
    const explicitReprint = existingIntake.status === "retry_allowed" && Number(existingIntake.reprintNumber) > 0;
    const heldBecause = isClosedIntakeJobStatus(assignedJob.status) && !explicitReprint
      ? "assigned_job_on_closed_job"
      : revisionReorderProofHold(assignedJob as any, assignedItem as any);
    if (heldBecause) {
      const heldReason = canonicalReviewReason([heldBecause]);
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
      return json({ ok: true, fileName, plan: { decision: "review", rule: null, machine: null, reasons: ["assigned_but_held", heldBecause], candidates: [], autoCreated: false } });
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
    const baseRipName = ripFileBaseName(assignedItem as any, fileName) || String(existingIntake.authoritativeTicket || assignedJob.jobTicket || "");
    // 2026-11-20: same naming rules as an automatic match (kept name on a retry / reprint; revision,
    // collision mark and open-run token for a file that is named here for the first time).
    let assignedNaming: RoutedNaming;
    try {
      assignedNaming = await nameRoutedFile(existingIntake, assignedItem as any, assignedItem.itemTicket || assignedJob.jobTicket || null, baseRipName);
    } catch {
      const storedRun = { revision: existingIntake.revisionNumber, reprint: existingIntake.reprintNumber, attempt: existingIntake.attemptNumber };
      const storedDefault = storedRun.revision === 1 && storedRun.reprint === 0 && storedRun.attempt === 1;
      assignedNaming = { ok: true, ripName: storedDefault ? baseRipName : applyRunSuffix(baseRipName, storedRun), run: storedRun, fresh: false };
    }
    if (!assignedNaming.ok) {
      return json({ ok: true, fileName, plan: { decision: "review", rule: null, machine: null, reasons: ["assigned_but_held", assignedNaming.reason], candidates: [], autoCreated: false } });
    }
    const ripName = assignedNaming.ripName;
    await db.printIntake.update({
      where: { id: existingIntake.id },
      data: {
        status: "routed",
        printer: machineDecision.machine,
        routingRule: "assigned_by_owner",
        routedFilename: ripName,
        ...(assignedNaming.fresh ? { revisionNumber: assignedNaming.run.revision, reprintNumber: assignedNaming.run.reprint, attemptNumber: assignedNaming.run.attempt } : {}),
        authoritativeTicket: assignedItem.itemTicket || assignedJob.jobTicket,
        productionJobItemId: assignedItem.id, // 2026-11-19: exact item link
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
      artworkUrl: true, printFileUrl: true, proofStatus: true,
      items: {
        select: {
          id: true, itemTicket: true, ripJobName: true, suggestedFileName: true,
          productTitle: true, selectedFinish: true, materialSummary: true, machineSummary: true, reorderArtworkMode: true,
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
    proofStatus: (job as any).proofStatus ?? null,
    items: job.items,
    fileNames: job.files.flatMap((file) => [file.fileName, file.originalFileName || ""]).filter(Boolean),
  }));

  const plan = decideIntakeRoute({ fileName, subfolder, jobs: intakeJobs, machineContextFor: (job, item) => machineContext(job.id, job.items.length, item.itemTicket, job.fileNames) });
  // Patch B: a file never alternates presses between polls — once this exact
  // file was routed against this job, it keeps the press it was sent to.
  // 2026-11-20 (E2): the row of THIS file that belongs to the planned job + item. A row that belongs to
  // another job (or another item) is somebody else's history and is never re-pointed.
  const rowItemMatches = (row: any) => {
    if (row.productionJobItemId) return !plan.itemId || row.productionJobItemId === plan.itemId;
    const rowTicket = String(row.authoritativeTicket || "");
    if (!ITEM_TICKET_RE.test(rowTicket) || !plan.itemTicket) return true;
    return rowTicket.toUpperCase() === String(plan.itemTicket).toUpperCase();
  };
  const ownRow: any | null = plan.decision === "route" ? rowsOfThisFile.find((row) => intakeRowJobId(row) === plan.jobId && rowItemMatches(row)) || null : null;
  // a row never linked to any job (a file that waited in review) is this file's own row
  const adoptableRow: any | null = !ownRow && existingIntake && !intakeRowJobId(existingIntake) ? existingIntake : null;
  const targetRow: any | null = ownRow || adoptableRow;
  if (plan.decision === "route" && ownRow?.status === "routed" && (ownRow.printer === "mimaki" || ownRow.printer === "roland")) {
    plan.machine = ownRow.printer;
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
    const ticket = plan.itemTicket || plan.jobTicket;
    const planJob = jobs.find((job) => job.id === plan.jobId);
    const planItem = planJob?.items.find((item) => item.id === plan.itemId) || null;
    // 15H.5 run identity, 2026-11-19 routed names, 2026-11-20 collision / open-run rules: see nameRoutedFile.
    let naming: RoutedNaming | null = null;
    try {
      naming = await nameRoutedFile(targetRow, (planItem || { id: String(plan.itemId || ""), itemTicket: plan.itemTicket, ripJobName: null, suggestedFileName: null }) as any, ticket, plan.ripName || "");
    } catch {
      naming = null; // naming lookups must never break routing — the plain name is used
    }
    if (naming && !naming.ok) {
      const reasons = [`matched_by_${plan.rule}_but_name_collision`, naming.reason];
      await recordReviewRow(reasons);
      return json({ ok: true, fileName, plan: { ...plan, decision: "review", rule: null, machine: null, machineRule: null, ripName: null, jobId: null, itemId: null, reasons, autoCreated: false } });
    }
    try {
      const run = naming && naming.ok ? naming.run : targetRow ? { revision: targetRow.revisionNumber, reprint: targetRow.reprintNumber, attempt: targetRow.attemptNumber } : { revision: 1, reprint: 0, attempt: 1 };
      if (naming && naming.ok) {
        routedRipName = naming.ripName;
      } else {
        const runIsDefault = run.revision === 1 && run.reprint === 0 && run.attempt === 1;
        routedRipName = runIsDefault ? plan.ripName : applyRunSuffix(plan.ripName || "", run);
      }
      const freshCounters = naming && naming.ok && naming.fresh ? { revisionNumber: run.revision, reprintNumber: run.reprint, attemptNumber: run.attempt } : {};
      // E2: the plain-hash row belongs to another job / item -> this item gets its own row; that one is not touched.
      const reuseOf = !targetRow && existingIntake ? existingIntake : null;
      const rowKey = targetRow ? String(targetRow.fileHashSha256) : reuseOf ? intakeReuseKey(fileHash, String(plan.itemId || plan.jobId || "")) : fileHash;
      await db.printIntake.upsert({
        where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: rowKey } },
        update: { matchedProductionJobId: plan.jobId, authoritativeTicket: ticket, printer: plan.machine, routingRule: plan.rule, routedFilename: routedRipName, status: "routed", productionJobItemId: plan.itemId || null, ...freshCounters },
        create: {
          shop: setting.shop,
          originalFilename: fileName,
          originalSubfolder: subfolder || null,
          fileHashSha256: rowKey,
          fileSize,
          status: "routed",
          matchedProductionJobId: plan.jobId,
          authoritativeTicket: ticket,
          productionJobItemId: plan.itemId || null, // 2026-11-19: exact item link
          printer: plan.machine,
          printMode: null,
          routingRule: plan.rule,
          routedFilename: routedRipName,
          revisionNumber: run.revision,
          reprintNumber: run.reprint,
          attemptNumber: run.attempt,
          rawParsedHints: reuseOf
            ? appendIntakeAudit(
                JSON.stringify({ matched: true, rule: plan.rule, run, contentHashSha256: fileHash, reuseOf: { printIntakeId: reuseOf.id, productionJobId: intakeRowJobId(reuseOf), ticket: reuseOf.authoritativeTicket || null, routedFilename: reuseOf.routedFilename || null } }),
                { at: new Date().toISOString(), actor: "route-plan", action: "routed_again_for_another_item", reason: `same file as ${reuseOf.authoritativeTicket || reuseOf.id}; that record is unchanged` },
              )
            : JSON.stringify({ matched: true, rule: plan.rule, run }),
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
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, fileName, subfolder?, fileHash?, dryRun?} for a deterministic print-intake routing plan. A normal plan records its decision; dryRun: true writes nothing." }),
    { headers: { "Content-Type": "application/json" } },
  );
