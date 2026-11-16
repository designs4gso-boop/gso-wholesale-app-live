// 2026-11-15 — a job's staff NOTES and its latest "put on hold" record, read
// for ONE job.
//
// The shared Production loader sends only the 20 newest history events per
// job. Every checklist tick writes one event and every QC result two, so on a
// busy job the staff notes dropped off the job page's Notes tab, and "On hold
// — check the notes" pointed at notes that were no longer there.
//
// Read only. The rows pass through the same money masking as every other
// history event before they reach a viewer without financial access.

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { redactJobFinancials } from "./production-financial-redaction";

const NOTE_LIMIT = 100;

const eventKey = (event: any) => String(event?.id || `${new Date(event?.createdAt || 0).toISOString()}|${event?.eventType}|${event?.message}`);

/** `job.events` plus this job's notes (newest 100) and, for an On Hold job, the status change that put it on hold. */
export async function jobEventsWithNoteHistory(request: Request, job: any, showFinancials: boolean): Promise<any[]> {
  const current: any[] = job?.events || [];
  if (!job?.id) return current;
  const { session } = await authenticate.admin(request);
  const where = { shop: session.shop, jobId: String(job.id) };
  const [notes, holds] = await Promise.all([
    db.productionJobEvent.findMany({ where: { ...where, eventType: { in: ["note"] } }, orderBy: { createdAt: "desc" }, take: NOTE_LIMIT }),
    String(job.status) === "on_hold"
      ? db.productionJobEvent.findMany({ where: { ...where, eventType: { in: ["status_change"] }, newValue: "on_hold" }, orderBy: { createdAt: "desc" }, take: 1 })
      : Promise.resolve([] as any[]),
  ]);
  // only the two kinds asked for, whatever the query returned
  const extra = [...(notes || []), ...(holds || [])].filter((event: any) => ["note", "status_change"].includes(String(event?.eventType)));
  const shown: any[] = showFinancials ? extra : redactJobFinancials({ events: extra }).events;
  const seen = new Set(current.map(eventKey));
  return [...current, ...shown.filter((event) => !seen.has(eventKey(event)))];
}
