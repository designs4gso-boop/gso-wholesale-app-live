// 2026-11-19 — Shopify privacy / compliance webhooks.
//
// customers/data_request, customers/redact and shop/redact used to be
// acknowledged and forgotten. They are now RECORDED durably (one row per
// Shopify webhook id) with a due date, and the owner sees them on the Privacy
// Requests page.
//
// What is deliberately NOT automatic:
//   * No customer data is erased by the webhook itself. A redaction is applied
//     by the owner from the page, after a preview of exactly which records
//     match. It blanks contact fields; it never deletes a quote, a job or
//     their production / financial history.
//   * shop/redact (sent 48 hours after an uninstall) is only recorded. Erasing
//     the whole ERP on an uninstall — including an accidental one — is not
//     something a webhook should do.
// Matching is by the Shopify customer id (wholesale applications) and by the
// exact e-mail address, case-insensitive. Never by name.

export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ComplianceTopic = (typeof COMPLIANCE_TOPICS)[number];
export const COMPLIANCE_DUE_DAYS = 30;
export const REDACTED_TEXT = "[redacted]";

const text = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);

/** "CUSTOMERS_REDACT" / "customers/redact" -> "customers/redact"; anything else -> null. */
export function normalizeComplianceTopic(topic: unknown): ComplianceTopic | null {
  const value = String(topic ?? "").trim().toLowerCase().replace(/_/g, "/").replace("data/request", "data_request");
  return (COMPLIANCE_TOPICS as readonly string[]).includes(value) ? (value as ComplianceTopic) : null;
}

export type ComplianceFacts = { customerId: string | null; customerEmail: string | null; customerPhone: string | null; ordersRequested: string[] };

/** The few payload facts needed to act on a request. The raw payload is not stored. */
export function complianceFacts(payload: any): ComplianceFacts {
  const customer = payload?.customer || {};
  const orders = Array.isArray(payload?.orders_to_redact) ? payload.orders_to_redact : Array.isArray(payload?.orders_requested) ? payload.orders_requested : [];
  return {
    customerId: text(customer.id, 40) || null,
    customerEmail: text(customer.email, 200).toLowerCase() || null,
    customerPhone: text(customer.phone, 40) || null,
    ordersRequested: orders.slice(0, 200).map((id: unknown) => text(id, 40)).filter(Boolean),
  };
}

/** Record one webhook. The same Shopify webhook id delivered again writes nothing. */
export async function recordComplianceRequest(
  dbClient: any,
  input: { shop: string; topic: unknown; webhookId: string | null; payload: any; now?: Date },
): Promise<{ result: "recorded" | "duplicate" | "ignored"; id: string | null }> {
  const topic = normalizeComplianceTopic(input.topic);
  if (!topic) return { result: "ignored", id: null };
  const facts = complianceFacts(input.payload);
  const now = input.now || new Date();
  // Without a webhook id the request is keyed on its content, so a retry still collapses.
  const webhookId = text(input.webhookId, 120) || `${topic}:${facts.customerId || ""}:${facts.customerEmail || ""}:${facts.ordersRequested.join(",")}`.slice(0, 180);
  const existing = await dbClient.complianceRequest.findFirst({ where: { shop: input.shop, webhookId } });
  if (existing) return { result: "duplicate", id: existing.id };
  const created = await dbClient.complianceRequest.create({
    data: {
      shop: input.shop,
      topic,
      webhookId,
      customerId: facts.customerId,
      customerEmail: facts.customerEmail,
      customerPhone: facts.customerPhone,
      ordersRequested: facts.ordersRequested.length ? JSON.stringify(facts.ordersRequested) : null,
      status: "received",
      receivedAt: now,
      dueAt: new Date(now.getTime() + COMPLIANCE_DUE_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { result: "recorded", id: created.id };
}

/** A Shopify customer id as it may be stored: the bare number or the GraphQL gid. Exact match only. */
export function customerIdForms(customerId: string): string[] {
  const bare = String(customerId).replace(/^gid:\/\/shopify\/Customer\//, "");
  return [bare, `gid://shopify/Customer/${bare}`];
}

export type RedactionPlan = { quotes: number; productionJobs: number; wholesaleApplications: number; leads: number; total: number; matchable: boolean };

const emailMatch = (email: string) => ({ equals: email, mode: "insensitive" as const });

/** READ ONLY: how many records hold this customer's contact details. */
export async function planCustomerRedaction(dbClient: any, shop: string, facts: { customerId?: string | null; customerEmail?: string | null }): Promise<RedactionPlan> {
  const email = text(facts.customerEmail).toLowerCase();
  const customerId = text(facts.customerId);
  if (!email && !customerId) return { quotes: 0, productionJobs: 0, wholesaleApplications: 0, leads: 0, total: 0, matchable: false };
  const wholesaleWhere = { shop, OR: [...(customerId ? [{ customerId: { in: customerIdForms(customerId) } }] : []), ...(email ? [{ email: emailMatch(email) }] : [])] };
  const [quotes, productionJobs, wholesaleApplications, leads] = await Promise.all([
    email ? dbClient.quote.count({ where: { shop, email: emailMatch(email) } }) : 0,
    email ? dbClient.productionJob.count({ where: { shop, OR: [{ email: emailMatch(email) }, { proofCustomerEmail: emailMatch(email) }] } }) : 0,
    dbClient.wholesaleApplication.count({ where: wholesaleWhere }),
    email ? dbClient.agentReviewQueueItem.count({ where: { shop, email: emailMatch(email) } }) : 0,
  ]);
  return { quotes, productionJobs, wholesaleApplications, leads, total: quotes + productionJobs + wholesaleApplications + leads, matchable: true };
}

/**
 * OWNER ACTION: blank this customer's contact fields on the matching records.
 * Records are kept (quotes, jobs, production and cost history are business
 * records); only name / e-mail / phone are replaced. The request row keeps an
 * audit of what was changed and by whom.
 */
export async function applyCustomerRedaction(dbClient: any, input: { shop: string; requestId: string; actor: string; now?: Date }): Promise<{ ok: boolean; message: string; plan?: RedactionPlan }> {
  const actor = text(input.actor, 120);
  if (!actor) return { ok: false, message: "A signed-in owner is required." };
  const request = await dbClient.complianceRequest.findFirst({ where: { shop: input.shop, id: input.requestId } });
  if (!request) return { ok: false, message: "The request was not found." };
  if (request.topic !== "customers/redact") return { ok: false, message: "Only a customer erasure request can be applied here." };
  if (request.status === "completed") return { ok: false, message: "This request was already completed." };
  const email = text(request.customerEmail).toLowerCase();
  const customerId = text(request.customerId);
  const plan = await planCustomerRedaction(dbClient, input.shop, { customerEmail: email, customerId });
  if (!plan.matchable) return { ok: false, message: "The request carries no e-mail address or customer id to match on." };
  const now = input.now || new Date();
  await dbClient.$transaction(async (tx: any) => {
    if (email) {
      await tx.quote.updateMany({ where: { shop: input.shop, email: emailMatch(email) }, data: { customerName: REDACTED_TEXT, email: null, phone: null } });
      await tx.productionJob.updateMany({ where: { shop: input.shop, email: emailMatch(email) }, data: { customerName: REDACTED_TEXT, email: null, phone: null } });
      await tx.productionJob.updateMany({ where: { shop: input.shop, proofCustomerEmail: emailMatch(email) }, data: { proofCustomerName: null, proofCustomerEmail: null } });
      await tx.agentReviewQueueItem.updateMany({ where: { shop: input.shop, email: emailMatch(email) }, data: { customerName: REDACTED_TEXT, email: null, phone: null } });
    }
    await tx.wholesaleApplication.updateMany({
      where: { shop: input.shop, OR: [...(customerId ? [{ customerId: { in: customerIdForms(customerId) } }] : []), ...(email ? [{ email: emailMatch(email) }] : [])] },
      data: { email: REDACTED_TEXT, phone: null, taxId: null, resaleNumber: null, notes: null },
    });
    await tx.complianceRequest.update({
      where: { id: request.id },
      data: {
        status: "completed",
        completedBy: actor,
        completedAt: now,
        resultSummary: `Contact details blanked on ${plan.quotes} quote(s), ${plan.productionJobs} production job(s), ${plan.wholesaleApplications} wholesale application(s), ${plan.leads} lead(s). Records kept.`,
        // the request no longer needs the address once it has been applied
        customerEmail: null,
        customerPhone: null,
      },
    });
  });
  return { ok: true, message: `Contact details blanked on ${plan.total} record(s). The records themselves were kept.`, plan };
}

/** OWNER ACTION: close a request that needed no change (answered by hand, nothing held, shop still installed). */
export async function closeComplianceRequest(dbClient: any, input: { shop: string; requestId: string; actor: string; note: string; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const note = text(input.note, 400);
  if (!note) return { ok: false, message: "Write what was done for this request." };
  const request = await dbClient.complianceRequest.findFirst({ where: { shop: input.shop, id: input.requestId } });
  if (!request) return { ok: false, message: "The request was not found." };
  if (request.status === "completed") return { ok: false, message: "This request was already completed." };
  await dbClient.complianceRequest.update({ where: { id: request.id }, data: { status: "completed", completedBy: text(input.actor, 120), completedAt: input.now || new Date(), resultSummary: note } });
  return { ok: true, message: "Request closed." };
}
