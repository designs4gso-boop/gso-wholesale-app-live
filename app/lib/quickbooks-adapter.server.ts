// 2026-11-19 — QuickBooks READ-ONLY adapter boundary.
//
// NOT CONNECTED. There are no Intuit credentials in this app and no call to
// Intuit anywhere in this file. This is the shape a future connection plugs
// into, so that connecting QuickBooks later does not mean redesigning the ERP:
//
//   QuickBooks (read) -> QuickBooksReadAdapter -> toStageInput -> stageTransaction
//     -> Release to Production (a person reviews and releases)
//
// Rules held here:
//   * READ ONLY. The interface has no create / update / void / send / delete
//     method, so no caller can write to QuickBooks through it.
//   * Staging only. A document becomes a StagedTransaction; it never becomes a
//     job, and no line, customer or product is classified or mapped
//     automatically. WHICH document state may be released, deposits, voids,
//     refunds and customer mapping are the admin's decisions and are NOT
//     encoded here.
//   * No sample data. The not-connected adapter returns nothing; nothing is
//     simulated in production.

import { stageTransaction, type StageInput, type StagedSource } from "./staged-transaction.server";

export type QuickBooksDocumentType = "invoice" | "estimate";

/** One QuickBooks document, reduced to the facts staging needs. Amounts are as QuickBooks reports them. */
export type QuickBooksDocument = {
  type: QuickBooksDocumentType;
  id: string; // QuickBooks Id (stable)
  syncToken?: string | null;
  docNumber?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  txnDate?: string | null; // YYYY-MM-DD
  totalAmount?: number | null;
  balance?: number | null;
  status?: string | null; // as reported; never interpreted here
  updatedAt?: string | null; // ISO
  lines: Array<{ id: string; description?: string | null; quantity?: number | null; amount?: number | null; itemId?: string | null; itemName?: string | null }>;
};

export interface QuickBooksReadAdapter {
  readonly connected: boolean;
  /** Why it is not connected (shown to the admin). */
  readonly reason: string | null;
  listInvoices(options: { updatedSince?: Date | null; limit?: number }): Promise<QuickBooksDocument[]>;
  listEstimates(options: { updatedSince?: Date | null; limit?: number }): Promise<QuickBooksDocument[]>;
}

/** The only adapter in this release. */
export const QUICKBOOKS_NOT_CONNECTED: QuickBooksReadAdapter = {
  connected: false,
  reason: "QuickBooks is not connected. Connecting needs an Intuit developer app and the admin's consent for read-only access.",
  async listInvoices() { return []; },
  async listEstimates() { return []; },
};

const SOURCE_OF: Record<QuickBooksDocumentType, StagedSource> = { invoice: "quickbooks_invoice", estimate: "quickbooks_estimate" };
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** Pure mapping: a QuickBooks document -> what staging stores. Nothing is classified, mapped or decided. */
export function toStageInput(shop: string, doc: QuickBooksDocument): StageInput {
  if (!SOURCE_OF[doc?.type]) throw new Error("Only invoices and estimates are staged.");
  const id = text(doc.id, 120);
  if (!id) throw new Error("A QuickBooks document needs its Id.");
  const txnDate = doc.txnDate && /^\d{4}-\d{2}-\d{2}/.test(doc.txnDate) ? new Date(`${doc.txnDate.slice(0, 10)}T12:00:00.000Z`) : null;
  const updatedAt = doc.updatedAt ? new Date(doc.updatedAt) : null;
  return {
    shop,
    source: SOURCE_OF[doc.type],
    externalId: id,
    docNumber: text(doc.docNumber, 60) || null,
    externalCustomerId: text(doc.customerId, 60) || null,
    customerName: text(doc.customerName, 200) || null,
    txnDate,
    totalAmount: doc.totalAmount ?? null,
    balance: doc.balance ?? null,
    externalStatus: text(doc.status, 60) || null,
    provider: "quickbooks",
    transactionType: doc.type,
    rawReference: `${doc.type}:${id}${doc.syncToken ? `@${text(doc.syncToken, 20)}` : ""}`,
    sourceUpdatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
    lines: (doc.lines || []).map((line) => ({ key: text(line.id, 60), description: line.description, quantity: line.quantity, amount: line.amount, externalItemId: line.itemId, externalItemName: line.itemName })),
  };
}

export type QuickBooksSyncResult = { ok: true; staged: number; refreshed: number } | { ok: false; reason: string };

/**
 * Pull documents through the adapter into staging. Idempotent (staging is keyed
 * on shop + source + QuickBooks Id): running it twice stages nothing twice,
 * never resets a review and never touches a job. With the not-connected
 * adapter it does nothing and says why.
 */
export async function syncQuickBooksToStaging(dbClient: any, shop: string, adapter: QuickBooksReadAdapter = QUICKBOOKS_NOT_CONNECTED, options: { updatedSince?: Date | null; limit?: number } = {}): Promise<QuickBooksSyncResult> {
  if (!adapter.connected) return { ok: false, reason: adapter.reason || "QuickBooks is not connected." };
  const documents = [...(await adapter.listInvoices(options)), ...(await adapter.listEstimates(options))];
  let staged = 0;
  let refreshed = 0;
  for (const doc of documents) {
    const outcome = await stageTransaction(dbClient, toStageInput(shop, doc));
    if (outcome.result === "staged") staged += 1; else refreshed += 1;
  }
  return { ok: true, staged, refreshed };
}
