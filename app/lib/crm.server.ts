// 2026-11-19 — internal CRM service: leads, accounts and their history.
//
// Every write is shop-scoped and appends a CrmLeadEvent (append-only). Nothing
// here contacts a customer, prices anything, or creates a production job. A
// lead reaches production only the normal way:
//   lead -> account -> quote -> approved quote -> createProductionJobFromSource.

import { CLOSED_LEAD_STATUSES, leadDisplayName, leadTransitionVerdict, parseFollowUpDate, parseLeadInput, type LeadStatus } from "./crm";

type Result<T = {}> = ({ ok: true; message: string } & T) | { ok: false; message: string };
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

async function leadOf(dbClient: any, shop: string, id: string) {
  return id ? dbClient.crmLead.findFirst({ where: { shop, id } }) : null;
}

async function logEvent(dbClient: any, lead: { id: string; shop: string }, event: string, actor: string, extra: { fromStatus?: string | null; toStatus?: string | null; detail?: string | null } = {}) {
  await dbClient.crmLeadEvent.create({
    data: { shop: lead.shop, leadId: lead.id, event, actor: text(actor, 120) || null, fromStatus: extra.fromStatus ?? null, toStatus: extra.toStatus ?? null, detail: text(extra.detail, 1000) || null },
  });
}

export async function createLead(dbClient: any, input: { shop: string; actor: string; fields: Record<string, unknown> }): Promise<Result<{ lead?: any }>> {
  const parsed = parseLeadInput(input.fields);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  const lead = await dbClient.crmLead.create({ data: { shop: input.shop, ...parsed.lead, status: "new", createdBy: text(input.actor, 120) || null } });
  await logEvent(dbClient, lead, "created", input.actor, { toStatus: "new", detail: `Source: ${parsed.lead.source}` });
  return { ok: true, message: "Lead created.", lead };
}

export async function updateLead(dbClient: any, input: { shop: string; id: string; actor: string; fields: Record<string, unknown> }): Promise<Result> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  const parsed = parseLeadInput(input.fields);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  await dbClient.crmLead.update({ where: { id: lead.id }, data: parsed.lead });
  await logEvent(dbClient, lead, "edited", input.actor);
  return { ok: true, message: "Lead saved." };
}

/** Assign to a named person (roles decide who may assign; this only records it). An unqualified new lead moves to Assigned. */
export async function assignLead(dbClient: any, input: { shop: string; id: string; actor: string; staffName: unknown; staffId?: unknown }): Promise<Result> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  const staffName = text(input.staffName, 120);
  const staffId = text(input.staffId, 60);
  if (!staffName && !staffId) {
    await dbClient.crmLead.update({ where: { id: lead.id }, data: { assignedStaffName: null, assignedStaffId: null } });
    await logEvent(dbClient, lead, "unassigned", input.actor);
    return { ok: true, message: "Lead unassigned." };
  }
  const moves = lead.status === "new" || lead.status === "qualified";
  await dbClient.crmLead.update({ where: { id: lead.id }, data: { assignedStaffName: staffName || null, assignedStaffId: staffId || null, ...(moves ? { status: "assigned" } : {}) } });
  await logEvent(dbClient, lead, "assigned", input.actor, { detail: `Assigned to ${staffName || staffId}`, ...(moves ? { fromStatus: lead.status, toStatus: "assigned" } : {}) });
  return { ok: true, message: `Assigned to ${staffName || staffId}.` };
}

export async function changeLeadStatus(dbClient: any, input: { shop: string; id: string; actor: string; to: unknown; reason?: unknown; now?: Date }): Promise<Result> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  const verdict = leadTransitionVerdict(lead, input.to, { reason: input.reason });
  if (!verdict.ok) return verdict;
  const now = input.now || new Date();
  const to: LeadStatus = verdict.to;
  const reason = text(input.reason, 300) || null;
  const closing = CLOSED_LEAD_STATUSES.includes(to);
  await dbClient.crmLead.update({
    where: { id: lead.id },
    data: {
      status: to,
      ...(to === "contacted" ? { lastContactedAt: now } : {}),
      ...(to === "won" ? { wonAt: now, lostAt: null, outcomeReason: reason } : {}),
      ...(to === "lost" ? { lostAt: now, wonAt: null, outcomeReason: reason } : {}),
      // reopening clears the outcome; the history keeps what it was
      ...(!closing && CLOSED_LEAD_STATUSES.includes(lead.status) ? { wonAt: null, lostAt: null, outcomeReason: null } : {}),
    },
  });
  await logEvent(dbClient, lead, "status_changed", input.actor, { fromStatus: lead.status, toStatus: to, detail: reason });
  return { ok: true, message: `Lead moved to ${to.replace(/_/g, " ")}.` };
}

export async function setLeadFollowUp(dbClient: any, input: { shop: string; id: string; actor: string; date: unknown }): Promise<Result> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  const parsed = parseFollowUpDate(input.date);
  if (!parsed.ok) return parsed;
  await dbClient.crmLead.update({ where: { id: lead.id }, data: { nextFollowUpAt: parsed.date } });
  await logEvent(dbClient, lead, parsed.date ? "follow_up_set" : "follow_up_cleared", input.actor, { detail: parsed.date ? parsed.date.toISOString().slice(0, 10) : null });
  return { ok: true, message: parsed.date ? "Follow-up date saved." : "Follow-up date cleared." };
}

export async function addLeadNote(dbClient: any, input: { shop: string; id: string; actor: string; note: unknown }): Promise<Result> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  const note = text(input.note, 1000);
  if (!note) return { ok: false, message: "Write the note first." };
  await logEvent(dbClient, lead, "note", input.actor, { detail: note });
  return { ok: true, message: "Note added." };
}

/**
 * Lead -> account. Idempotent: a lead that already has an account returns it.
 * An existing account is reused only on an EXACT email match in this shop —
 * never on a similar name.
 */
export async function convertLeadToAccount(dbClient: any, input: { shop: string; id: string; actor: string }): Promise<Result<{ accountId?: string; created?: boolean }>> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  if (lead.accountId) return { ok: true, message: "This lead already has a customer account.", accountId: lead.accountId, created: false };
  const existing = lead.email ? await dbClient.crmAccount.findFirst({ where: { shop: input.shop, email: lead.email, active: true } }) : null;
  const account = existing || await dbClient.crmAccount.create({
    data: { shop: input.shop, company: lead.company, contactName: lead.contactName, email: lead.email, phone: lead.phone, active: true, source: lead.source || "lead", createdBy: text(input.actor, 120) || null },
  });
  await dbClient.crmLead.update({ where: { id: lead.id }, data: { accountId: account.id } });
  await logEvent(dbClient, lead, "account_linked", input.actor, { detail: existing ? "Linked to the existing account with the same email." : "Customer account created." });
  return { ok: true, message: existing ? "Linked to the existing customer account." : "Customer account created.", accountId: account.id, created: !existing };
}

/**
 * Lead -> draft quote. Creates an EMPTY draft quote carrying the customer —
 * no line, no price: a person prices it in Quotes through the normal engine.
 * Idempotent: a lead that already has a quote returns that quote.
 */
export async function createDraftQuoteForLead(dbClient: any, input: { shop: string; id: string; actor: string }): Promise<Result<{ quoteId?: string; created?: boolean }>> {
  const lead = await leadOf(dbClient, input.shop, input.id);
  if (!lead) return { ok: false, message: "The lead was not found." };
  if (lead.quoteId) return { ok: true, message: "This lead already has a quote.", quoteId: lead.quoteId, created: false };
  if (CLOSED_LEAD_STATUSES.includes(lead.status)) return { ok: false, message: "Reopen the lead before creating a quote." };
  const quote = await dbClient.quote.create({
    data: {
      shop: input.shop,
      customerName: lead.contactName || lead.company || null,
      company: lead.company,
      email: lead.email,
      phone: lead.phone,
      status: "draft",
      notes: `From CRM lead: ${leadDisplayName(lead)}${lead.productInterest ? `\nInterested in: ${lead.productInterest}` : ""}`,
    },
  });
  // Claim the lead only if no quote was linked meanwhile (two clicks -> one linked quote).
  const claimed = await dbClient.crmLead.updateMany({ where: { id: lead.id, shop: input.shop, quoteId: null }, data: { quoteId: quote.id, status: "quote_created" } });
  if (!claimed?.count) {
    const current = await leadOf(dbClient, input.shop, lead.id);
    return { ok: true, message: "This lead already has a quote.", quoteId: current?.quoteId || quote.id, created: false };
  }
  await logEvent(dbClient, lead, "quote_created", input.actor, { fromStatus: lead.status, toStatus: "quote_created", detail: `Draft quote ${quote.id}` });
  return { ok: true, message: "Draft quote created. Add the items and price it in Quotes.", quoteId: quote.id, created: true };
}

/**
 * Agent Review Queue item -> CRM lead. Idempotent on the queue item (unique
 * shop + sourceQueueItemId): the same queue item is never two leads.
 */
export async function leadFromQueueItem(dbClient: any, input: { shop: string; queueItemId: string; actor: string }): Promise<Result<{ leadId?: string; created?: boolean }>> {
  const item = await dbClient.agentReviewQueueItem.findFirst({ where: { shop: input.shop, id: input.queueItemId } });
  if (!item) return { ok: false, message: "The queue item was not found." };
  const where = { shop_sourceQueueItemId: { shop: input.shop, sourceQueueItemId: item.id } };
  const existing = await dbClient.crmLead.findUnique({ where });
  if (existing) return { ok: true, message: "This queue item is already a lead.", leadId: existing.id, created: false };
  try {
    const lead = await dbClient.crmLead.create({
      data: {
        shop: input.shop, company: item.company, contactName: item.customerName, email: item.email ? String(item.email).toLowerCase() : null, phone: item.phone,
        source: "agent", status: "new", productInterest: [item.productFamily, item.quantity].filter(Boolean).join(" · ") || null,
        notes: item.customerSafeSummary || null, sourceQueueItemId: item.id, quoteId: item.convertedQuoteId || null, createdBy: text(input.actor, 120) || null,
      },
    });
    await logEvent(dbClient, lead, "created", input.actor, { toStatus: "new", detail: "From the lead review queue." });
    return { ok: true, message: "Lead created from the queue item.", leadId: lead.id, created: true };
  } catch (error: any) {
    if (error?.code === "P2002") {
      const raced = await dbClient.crmLead.findUnique({ where });
      if (raced) return { ok: true, message: "This queue item is already a lead.", leadId: raced.id, created: false };
    }
    throw error;
  }
}
