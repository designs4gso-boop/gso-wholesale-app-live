// 2026-11-20 — Customers (CrmAccount): the account side of the CRM.
//
// ONE customer record (CrmAccount — no second customer model). Quotes and
// production jobs carry no customer id, so what belongs to a customer is found
// at read time by an EXACT match, never a similar name:
//   * the same e-mail address (case-insensitive), or
//   * the same company name (case-insensitive) on the quote / job company or
//     customer-name field.
// Nothing is copied or rewritten on quotes or jobs. Leads link by accountId.
// Internal only: nothing here sends a message, prices anything or creates work.

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const same = (value: string) => ({ equals: value, mode: "insensitive" as const });

export type AccountInput = { company: string | null; contactName: string | null; email: string | null; phone: string | null; notes: string | null };

export function parseAccountInput(raw: Record<string, unknown>): { ok: true; account: AccountInput } | { ok: false; errors: string[] } {
  const email = text(raw.email, 200).toLowerCase();
  const account: AccountInput = { company: text(raw.company, 200) || null, contactName: text(raw.contactName, 200) || null, email: email || null, phone: text(raw.phone, 60) || null, notes: text(raw.notes, 4000) || null };
  const errors: string[] = [];
  if (!account.company && !account.contactName && !account.email) errors.push("Enter a company, a contact name or an email.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("The email address does not look right.");
  return errors.length ? { ok: false, errors } : { ok: true, account };
}

export function accountDisplayName(account: { company?: string | null; contactName?: string | null; email?: string | null }): string {
  return text(account.company, 200) || text(account.contactName, 200) || text(account.email, 200) || "Unnamed customer";
}

/**
 * The exact-match rule, as Prisma OR conditions for a model that has
 * `email`, `company` and `customerName`. Null when the account has neither an
 * e-mail nor a company — then nothing is matched (never "everything").
 */
export function accountMatchConditions(account: { email?: string | null; company?: string | null }): any[] | null {
  const email = text(account.email, 200);
  const company = text(account.company, 200);
  const conditions = [...(email ? [{ email: same(email) }] : []), ...(company ? [{ company: same(company) }, { customerName: same(company) }] : [])];
  return conditions.length ? conditions : null;
}

async function logAccountEvent(dbClient: any, account: { id: string; shop: string }, event: string, actor: string, detail?: string | null) {
  await dbClient.crmAccountEvent.create({ data: { shop: account.shop, accountId: account.id, event, actor: text(actor, 120) || null, detail: text(detail, 1000) || null } });
}

type Result<T = {}> = ({ ok: true; message: string } & T) | { ok: false; message: string };

/** Add a customer. An existing ACTIVE customer with the same e-mail is returned instead of a second one. */
export async function createAccount(dbClient: any, input: { shop: string; actor: string; fields: Record<string, unknown>; source?: string }): Promise<Result<{ accountId?: string; created?: boolean }>> {
  const parsed = parseAccountInput(input.fields);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  if (parsed.account.email) {
    const existing = await dbClient.crmAccount.findFirst({ where: { shop: input.shop, email: parsed.account.email, active: true } });
    if (existing) return { ok: true, message: "This customer already exists.", accountId: existing.id, created: false };
  }
  const account = await dbClient.crmAccount.create({ data: { shop: input.shop, ...parsed.account, active: true, source: text(input.source, 40) || "manual", createdBy: text(input.actor, 120) || null } });
  await logAccountEvent(dbClient, account, "created", input.actor, `Source: ${account.source}`);
  return { ok: true, message: "Customer added.", accountId: account.id, created: true };
}

export async function updateAccount(dbClient: any, input: { shop: string; id: string; actor: string; fields: Record<string, unknown> }): Promise<Result> {
  const account = await dbClient.crmAccount.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!account) return { ok: false, message: "The customer was not found." };
  const parsed = parseAccountInput(input.fields);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  await dbClient.crmAccount.update({ where: { id: account.id }, data: parsed.account });
  await logAccountEvent(dbClient, account, "edited", input.actor);
  return { ok: true, message: "Customer saved." };
}

export async function setAccountActive(dbClient: any, input: { shop: string; id: string; actor: string; active: boolean }): Promise<Result> {
  const account = await dbClient.crmAccount.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!account) return { ok: false, message: "The customer was not found." };
  if (Boolean(account.active) === input.active) return { ok: true, message: input.active ? "Already active." : "Already inactive." };
  await dbClient.crmAccount.update({ where: { id: account.id }, data: { active: input.active } });
  await logAccountEvent(dbClient, account, input.active ? "reactivated" : "deactivated", input.actor);
  return { ok: true, message: input.active ? "Customer is active again." : "Customer marked inactive. Nothing was deleted." };
}

export async function addAccountNote(dbClient: any, input: { shop: string; id: string; actor: string; note: unknown }): Promise<Result> {
  const account = await dbClient.crmAccount.findFirst({ where: { shop: input.shop, id: input.id } });
  if (!account) return { ok: false, message: "The customer was not found." };
  const note = text(input.note, 1000);
  if (!note) return { ok: false, message: "Write the note first." };
  await logAccountEvent(dbClient, account, "note", input.actor, note);
  return { ok: true, message: "Note added." };
}

export type AccountLinks = {
  leads: any[]; quotes: any[]; jobs: any[];
  /** every item this customer has had made (newest job first) */
  items: Array<{ id: string; itemTicket: string | null; productTitle: string; quantity: number; jobId: string; jobTicket: string | null; reorderOf: string | null }>;
  reorders: number;
  lastActivityAt: Date | null;
};

/** READ ONLY. Everything that belongs to this customer by the exact-match rule. No price, cost or margin is read. */
export async function accountLinks(dbClient: any, shop: string, account: { id: string; email?: string | null; company?: string | null; updatedAt?: Date | null }, limits: { take?: number } = {}): Promise<AccountLinks> {
  const take = limits.take ?? 50;
  const match = accountMatchConditions(account);
  const [leads, quotes, jobs] = await Promise.all([
    dbClient.crmLead.findMany({ where: { shop, accountId: account.id }, orderBy: { updatedAt: "desc" }, take, select: { id: true, company: true, contactName: true, email: true, status: true, source: true, updatedAt: true, quoteId: true } }),
    match ? dbClient.quote.findMany({ where: { shop, OR: match }, orderBy: { updatedAt: "desc" }, take, select: { id: true, status: true, company: true, customerName: true, createdAt: true, updatedAt: true } }) : [],
    match ? dbClient.productionJob.findMany({
      where: { shop, OR: match }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, jobTicket: true, status: true, dueDate: true, createdAt: true, updatedAt: true, completedAt: true, items: { orderBy: { sortOrder: "asc" }, select: { id: true, itemTicket: true, productTitle: true, quantity: true, reorderSourceItemId: true } } },
    }) : [],
  ]);
  const items = (jobs as any[]).flatMap((job) => (job.items || []).map((item: any) => ({ id: item.id, itemTicket: item.itemTicket || null, productTitle: item.productTitle, quantity: Number(item.quantity) || 0, jobId: job.id, jobTicket: job.jobTicket || null, reorderOf: item.reorderSourceItemId || null })));
  const stamps = [account.updatedAt, ...(leads as any[]).map((row) => row.updatedAt), ...(quotes as any[]).map((row) => row.updatedAt), ...(jobs as any[]).map((row) => row.updatedAt)].filter(Boolean).map((value) => new Date(value as any).getTime()).filter(Number.isFinite);
  return { leads, quotes, jobs, items, reorders: items.filter((item) => item.reorderOf).length, lastActivityAt: stamps.length ? new Date(Math.max(...stamps)) : null };
}

/**
 * People and companies that appear on quotes or jobs but are not customers yet.
 * Offered to a person to add; nothing is added automatically.
 */
export async function customersNotYetAdded(dbClient: any, shop: string, limit = 30): Promise<Array<{ company: string | null; contactName: string | null; email: string | null; phone: string | null; from: string }>> {
  const [accounts, quotes, jobs] = await Promise.all([
    dbClient.crmAccount.findMany({ where: { shop }, select: { email: true, company: true }, take: 2000 }),
    dbClient.quote.findMany({ where: { shop }, orderBy: { updatedAt: "desc" }, take: 300, select: { company: true, customerName: true, email: true, phone: true } }),
    dbClient.productionJob.findMany({ where: { shop, status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, take: 300, select: { company: true, customerName: true, email: true, phone: true } }),
  ]);
  const key = (value: unknown) => text(value, 200).toLowerCase();
  const knownEmails = new Set((accounts as any[]).map((row) => key(row.email)).filter(Boolean));
  const knownCompanies = new Set((accounts as any[]).map((row) => key(row.company)).filter(Boolean));
  const seen = new Set<string>();
  const out: Array<{ company: string | null; contactName: string | null; email: string | null; phone: string | null; from: string }> = [];
  for (const [rows, from] of [[quotes, "quote"], [jobs, "job"]] as Array<[any[], string]>) {
    for (const row of rows) {
      const email = key(row.email);
      const company = text(row.company, 200) || text(row.customerName, 200);
      if (!email && !company) continue;
      if ((email && knownEmails.has(email)) || (company && knownCompanies.has(key(company)))) continue;
      const dedupe = email || key(company);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ company: company || null, contactName: text(row.company, 200) ? text(row.customerName, 200) || null : null, email: email || null, phone: text(row.phone, 60) || null, from });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
