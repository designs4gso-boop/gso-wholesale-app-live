// GSO Operations Agent Platform — Customer Follow-Up (drafts only; never sends).

export const FOLLOWUP_VERSION = "followup/1.0.0-2026-10-03";

export type FollowupCandidate = { id: string; kind: "lead" | "quote"; status: string; customerName?: string | null; company?: string | null; lastContactAt: string | Date; missingFields?: string[] };

export type FollowupDraft = { id: string; kind: "lead" | "quote"; daysSilent: number; subject: string; body: string; sendBy: "staff" };

const STALE_DAYS: Record<string, number> = { lead: 2, quote: 5 };
const ELIGIBLE: Record<string, string[]> = { lead: ["missing_customer_info", "needs_staff_review", "new"], quote: ["sent"] };

export function followupDrafts(candidates: FollowupCandidate[], now = new Date()): FollowupDraft[] {
  const out: FollowupDraft[] = [];
  for (const c of candidates) {
    if (!ELIGIBLE[c.kind].includes(c.status)) continue;
    const days = Math.floor((now.getTime() - new Date(c.lastContactAt).getTime()) / 86400000);
    if (!Number.isFinite(days) || days < STALE_DAYS[c.kind]) continue;
    const first = String(c.customerName ?? "").split(" ")[0];
    const greeting = `Hi${first ? ` ${first}` : ""},`;
    const body = c.kind === "lead"
      ? `${greeting} checking in on your request${c.missingFields?.length ? ` — the team still needs: ${c.missingFields.join(", ")}` : ""}. Reply here and we will get it to review.`
      : `${greeting} following up on the quote we sent. Happy to answer questions or adjust specs; pricing stays subject to final specs and staff review.`;
    out.push({ id: c.id, kind: c.kind, daysSilent: days, subject: c.kind === "lead" ? "Your GSO request" : "Your GSO quote", body, sendBy: "staff" });
  }
  return out;
}
