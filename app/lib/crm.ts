// 2026-11-19 — internal CRM vocabulary (leads / opportunities and accounts).
//
// INTERNAL ONLY. Nothing in the CRM sends an email, text, DM or form: a status
// such as "contacted" RECORDS that a person made contact. Pure, client-safe.

export const LEAD_STATUSES = ["new", "qualified", "assigned", "contact_pending", "contacted", "follow_up_due", "quote_created", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  qualified: "Qualified",
  assigned: "Assigned",
  contact_pending: "Contact pending",
  contacted: "Contacted",
  follow_up_due: "Follow-up due",
  quote_created: "Quote created",
  won: "Won",
  lost: "Lost",
};

export const OPEN_LEAD_STATUSES: readonly LeadStatus[] = ["new", "qualified", "assigned", "contact_pending", "contacted", "follow_up_due", "quote_created"];
export const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ["won", "lost"];

export const LEAD_SOURCES = ["manual", "referral", "walk_in", "phone", "website", "storefront", "agent", "existing_customer", "other"] as const;

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

export function isLeadStatus(value: unknown): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(String(value ?? ""));
}

export type LeadFacts = { status: string; assignedStaffName?: string | null; assignedStaffId?: string | null; quoteId?: string | null };

/**
 * May a lead move from its status to `to`? Returns the reason when it may not.
 *   - "assigned" needs someone assigned.
 *   - "quote_created" needs a linked quote (use "Create draft quote").
 *   - "lost" needs a reason. "won" may carry one.
 *   - a closed lead is reopened before it moves anywhere else.
 */
export function leadTransitionVerdict(lead: LeadFacts, to: unknown, input: { reason?: unknown } = {}): { ok: true; to: LeadStatus } | { ok: false; message: string } {
  if (!isLeadStatus(to)) return { ok: false, message: "Choose a lead status from the list." };
  const from = isLeadStatus(lead.status) ? lead.status : "new";
  if (from === to) return { ok: false, message: `The lead is already ${LEAD_STATUS_LABEL[to]}.` };
  if (CLOSED_LEAD_STATUSES.includes(from) && CLOSED_LEAD_STATUSES.includes(to)) return { ok: false, message: "Reopen the lead before changing its outcome." };
  if (to === "assigned" && !text(lead.assignedStaffName, 120) && !text(lead.assignedStaffId, 60)) return { ok: false, message: "Assign the lead to someone first." };
  if (to === "quote_created" && !text(lead.quoteId, 60)) return { ok: false, message: "Create or link a quote first." };
  if (to === "lost" && !text(input.reason, 300)) return { ok: false, message: "Say why the lead was lost." };
  return { ok: true, to };
}

export type LeadInput = {
  company: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  productInterest: string | null;
  notes: string | null;
};

/** No single field is required, but a lead must identify someone: a company, a name, an email or a phone. */
export function parseLeadInput(raw: Record<string, unknown>): { ok: true; lead: LeadInput } | { ok: false; errors: string[] } {
  const email = text(raw.email, 200).toLowerCase();
  const lead: LeadInput = {
    company: text(raw.company, 200) || null,
    contactName: text(raw.contactName, 200) || null,
    email: email || null,
    phone: text(raw.phone, 60) || null,
    source: (LEAD_SOURCES as readonly string[]).includes(text(raw.source, 40)) ? text(raw.source, 40) : "manual",
    productInterest: text(raw.productInterest, 300) || null,
    notes: text(raw.notes, 4000) || null,
  };
  const errors: string[] = [];
  if (!lead.company && !lead.contactName && !lead.email && !lead.phone) errors.push("Enter a company, a contact name, an email or a phone number.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("The email address does not look right.");
  return errors.length ? { ok: false, errors } : { ok: true, lead };
}

/** YYYY-MM-DD (or empty to clear) -> a date at noon UTC, so the day does not shift by time zone. */
export function parseFollowUpDate(raw: unknown): { ok: true; date: Date | null } | { ok: false; message: string } {
  const value = text(raw, 20);
  if (!value) return { ok: true, date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, message: "Enter the follow-up date as a calendar date." };
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? { ok: false, message: "Enter the follow-up date as a calendar date." } : { ok: true, date };
}

/** Display: an open lead whose follow-up date has arrived is due, whatever its stored status. */
export function leadFollowUpDue(lead: { status: string; nextFollowUpAt?: Date | string | null }, now: Date = new Date()): boolean {
  if (!lead.nextFollowUpAt || CLOSED_LEAD_STATUSES.includes(lead.status as LeadStatus)) return false;
  const due = new Date(lead.nextFollowUpAt).getTime();
  return Number.isFinite(due) && due <= now.getTime();
}

export function leadDisplayName(lead: { company?: string | null; contactName?: string | null; email?: string | null; phone?: string | null }): string {
  return text(lead.company, 200) || text(lead.contactName, 200) || text(lead.email, 200) || text(lead.phone, 60) || "Unnamed lead";
}
