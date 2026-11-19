// 2026-11-19 — staged business transactions (QuickBooks invoice / estimate, an
// agent proposal) and their RELEASE TO PRODUCTION.
//
//   outside system -> StagedTransaction (review) -> a person releases it
//     -> createProductionJobFromSource (released_transaction) -> job + items + tickets
//
// Rules this file holds:
//   * Staging never creates a ProductionJob. Only releaseStagedTransaction does,
//     and only through the canonical job service.
//   * Nothing is mapped automatically. Every staged line starts as
//     "needs_review"; a person marks it production (and names the production
//     items) or not production. A transaction with a line still in review
//     cannot be released.
//   * A release needs a named authorizing person. Which roles may release is
//     decided by the route (production-role-access.ts), not here.
//   * Nothing here reads from or writes to QuickBooks. WHICH QuickBooks state
//     may be released (invoice created / deposit / paid / estimate accepted)
//     is an owner decision that is deliberately NOT encoded: the screen shows
//     the balance and status and a person decides.

import { MANUAL_JOB_MAX_ITEMS, createProductionJobFromSource, type CreateJobResult, type ManualJobItemInput } from "./production-job-source.server";

export const STAGED_SOURCES = ["quickbooks_invoice", "quickbooks_estimate", "agent_proposal"] as const;
export type StagedSource = (typeof STAGED_SOURCES)[number];

export const STAGED_SOURCE_LABEL: Record<string, string> = {
  quickbooks_invoice: "QuickBooks invoice",
  quickbooks_estimate: "QuickBooks estimate",
  agent_proposal: "Agent proposal",
};

export type StagedLineClassification = "needs_review" | "production" | "non_production";

export type StagedLine = {
  key: string;
  description: string;
  quantity: number | null;
  amount: number | null;
  externalItemId: string | null;
  externalItemName: string | null;
  classification: StagedLineClassification;
  /** The production items a person split this line into (one invoice line can hold many designs). */
  productionItems: ManualJobItemInput[];
};

const text = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max);
const numberOrNull = (value: unknown) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * Lines as they arrive from the outside system. Every line is "needs_review":
 * no product, customer or accounting line is classified automatically.
 */
export function normalizeIncomingLines(raw: unknown): StagedLine[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 200).map((line: any, index) => ({
    key: text(line?.key || line?.id || `line-${index + 1}`, 60),
    description: text(line?.description || line?.name || "", 500),
    quantity: numberOrNull(line?.quantity),
    amount: numberOrNull(line?.amount),
    externalItemId: text(line?.externalItemId, 60) || null,
    externalItemName: text(line?.externalItemName, 200) || null,
    classification: "needs_review" as const,
    productionItems: [],
  }));
}

export function readStagedLines(stored: unknown): StagedLine[] {
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored || "[]") : stored;
    return (Array.isArray(parsed) ? parsed : []).map((line: any, index) => ({
      key: text(line?.key || `line-${index + 1}`, 60),
      description: text(line?.description, 500),
      quantity: numberOrNull(line?.quantity),
      amount: numberOrNull(line?.amount),
      externalItemId: text(line?.externalItemId, 60) || null,
      externalItemName: text(line?.externalItemName, 200) || null,
      classification: line?.classification === "production" || line?.classification === "non_production" ? line.classification : "needs_review",
      productionItems: Array.isArray(line?.productionItems) ? line.productionItems : [],
    }));
  } catch {
    return [];
  }
}

export type StageInput = {
  shop: string;
  source: StagedSource;
  externalId: string;
  docNumber?: string | null;
  externalCustomerId?: string | null;
  customerName?: string | null;
  txnDate?: Date | null;
  totalAmount?: number | null;
  balance?: number | null;
  externalStatus?: string | null;
  lines: unknown;
};

/**
 * Stage (or refresh) one outside transaction. Idempotent on shop + source +
 * externalId. A refresh updates the outside facts (balance, status, totals);
 * it never resets a review a person already did, never un-releases, and never
 * touches a ProductionJob.
 */
export async function stageTransaction(dbClient: any, input: StageInput): Promise<{ result: "staged" | "refreshed"; id: string }> {
  if (!(STAGED_SOURCES as readonly string[]).includes(input.source)) throw new Error(`Unknown staged transaction source "${input.source}".`);
  const externalId = text(input.externalId, 120);
  if (!externalId) throw new Error("A staged transaction needs the outside system's stable id.");
  const where = { shop_source_externalId: { shop: input.shop, source: input.source, externalId } };
  const facts = {
    docNumber: text(input.docNumber, 60) || null,
    externalCustomerId: text(input.externalCustomerId, 60) || null,
    customerName: text(input.customerName, 200) || null,
    txnDate: input.txnDate || null,
    totalAmount: numberOrNull(input.totalAmount),
    balance: numberOrNull(input.balance),
    externalStatus: text(input.externalStatus, 60) || null,
  };
  const existing = await dbClient.stagedTransaction.findUnique({ where });
  if (existing) {
    await dbClient.stagedTransaction.update({ where: { id: existing.id }, data: facts });
    return { result: "refreshed", id: existing.id };
  }
  const created = await dbClient.stagedTransaction.create({
    data: { shop: input.shop, source: input.source, externalId, ...facts, status: "staged", lines: JSON.stringify(normalizeIncomingLines(input.lines)) },
  });
  return { result: "staged", id: created.id };
}

export type ReleaseReadiness = { ok: true; items: ManualJobItemInput[] } | { ok: false; reasons: string[] };

/** Can this staged transaction be released, and with which production items? Pure. */
export function releaseReadiness(staged: { status: string; customerName?: string | null; lines: unknown } | null): ReleaseReadiness {
  if (!staged) return { ok: false, reasons: ["The transaction was not found."] };
  const reasons: string[] = [];
  if (staged.status === "released") reasons.push("This transaction was already released to production.");
  if (staged.status === "dismissed") reasons.push("This transaction was dismissed (not production work).");
  if (!text(staged.customerName)) reasons.push("The customer name is missing.");
  const lines = readStagedLines(staged.lines);
  if (!lines.length) reasons.push("The transaction has no lines.");
  const inReview = lines.filter((line) => line.classification === "needs_review");
  if (inReview.length) reasons.push(`${inReview.length} line(s) still need review — mark each line as production or not production.`);
  const items = lines.filter((line) => line.classification === "production").flatMap((line) => line.productionItems || []);
  const productionWithoutItems = lines.filter((line) => line.classification === "production" && !(line.productionItems || []).length);
  if (productionWithoutItems.length) reasons.push(`${productionWithoutItems.length} production line(s) have no production items listed.`);
  if (!inReview.length && !items.length) reasons.push("No line is marked as production work.");
  if (items.length > MANUAL_JOB_MAX_ITEMS) reasons.push(`A job can hold at most ${MANUAL_JOB_MAX_ITEMS} items — split the release.`);
  return reasons.length ? { ok: false, reasons } : { ok: true, items };
}

/** Save a person's line review (classification + production items). Only a staged transaction can be reviewed. */
export async function saveStagedReview(dbClient: any, input: { shop: string; id: string; lines: StagedLine[]; reviewNotes?: string; actor: string }): Promise<{ ok: boolean; message: string }> {
  const staged = await dbClient.stagedTransaction.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!staged) return { ok: false, message: "The transaction was not found." };
  if (staged.status !== "staged") return { ok: false, message: `This transaction is ${staged.status} and can no longer be reviewed.` };
  const stored = readStagedLines(staged.lines);
  // Only the review fields are taken from the form; the outside facts of each line stay as staged.
  const merged = stored.map((line) => {
    const posted = input.lines.find((candidate) => candidate.key === line.key);
    if (!posted) return line;
    const classification: StagedLineClassification = posted.classification === "production" || posted.classification === "non_production" ? posted.classification : "needs_review";
    return { ...line, classification, productionItems: classification === "production" ? posted.productionItems || [] : [] };
  });
  await dbClient.stagedTransaction.update({ where: { id: staged.id }, data: { lines: JSON.stringify(merged), reviewNotes: text(input.reviewNotes, 1000) || staged.reviewNotes || null } });
  return { ok: true, message: "Review saved." };
}

export type ReleaseResult = { ok: true; job: any; created: boolean; message: string } | { ok: false; message: string };

/**
 * RELEASE TO PRODUCTION. The only way a staged transaction becomes a job, and
 * it goes through the canonical job service. Retried or double-clicked, it
 * resolves to the same job (the service is idempotent per transaction id).
 */
export async function releaseStagedTransaction(
  dbClient: any,
  input: { shop: string; id: string; actor: string; dueDate?: string; notes?: string },
  deps: { createJob?: typeof createProductionJobFromSource } = {},
): Promise<ReleaseResult> {
  const actor = text(input.actor, 120);
  if (!actor) return { ok: false, message: "Releasing to production needs a signed-in, authorized person." };
  const staged = await dbClient.stagedTransaction.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!staged) return { ok: false, message: "The transaction was not found." };
  const createJob = deps.createJob || createProductionJobFromSource;
  const label = `${STAGED_SOURCE_LABEL[staged.source] || staged.source}${staged.docNumber ? ` ${staged.docNumber}` : ""}`;
  if (staged.status === "released" && staged.releasedJobId) {
    const job = await dbClient.productionJob.findFirst({ where: { shop: input.shop, id: staged.releasedJobId }, include: { items: true } });
    if (job) return { ok: true, job, created: false, message: `${label} was already released as ${job.jobTicket}.` };
  }
  const ready = releaseReadiness(staged);
  if (!ready.ok) return { ok: false, message: ready.reasons.join(" ") };
  let result: CreateJobResult;
  try {
    result = await createJob(dbClient, {
      shop: input.shop,
      actor,
      source: {
        type: "released_transaction",
        authorizedBy: actor,
        transactionId: staged.id,
        origin: staged.source,
        payload: { customerName: staged.customerName, reference: label, dueDate: input.dueDate, notes: text(input.notes, 1000) || undefined, items: ready.items },
      },
    });
  } catch (error: any) {
    return { ok: false, message: error?.message || "The production job could not be created." };
  }
  await dbClient.stagedTransaction.update({ where: { id: staged.id }, data: { status: "released", releasedJobId: result.job.id, releasedBy: actor, releasedAt: new Date() } });
  return { ok: true, job: result.job, created: result.created, message: `${label} released to production as ${result.job.jobTicket} (${(result.job.items || []).length} item(s)).` };
}

/** Mark a staged transaction as not production work. Nothing is deleted; QuickBooks is not touched. */
export async function dismissStagedTransaction(dbClient: any, input: { shop: string; id: string; actor: string; reason: string }): Promise<{ ok: boolean; message: string }> {
  const reason = text(input.reason, 300);
  if (!reason) return { ok: false, message: "Say why this transaction is not production work." };
  const staged = await dbClient.stagedTransaction.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!staged) return { ok: false, message: "The transaction was not found." };
  if (staged.status === "released") return { ok: false, message: "This transaction was already released to production." };
  await dbClient.stagedTransaction.update({ where: { id: staged.id }, data: { status: "dismissed", dismissedBy: text(input.actor, 120), dismissedAt: new Date(), reviewNotes: reason } });
  return { ok: true, message: "Marked as not production work. Nothing was changed in QuickBooks." };
}
