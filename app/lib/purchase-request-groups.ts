// Purchase Requests page grouping (hotfix 2026-10-04).
//
// The loader of app/routes/app.erp.purchase-requests.tsx and its component
// must agree on exactly which groups exist. Keeping the grouping here, with a
// single exported key list, lets a unit test pin that contract so a missing
// destructure can never again surface as `ReferenceError: X is not defined`
// in the browser. Pure, client-safe, no Prisma.

export type PurchaseRequestLike = {
  status: string;
  sentAt?: string | Date | null;
  followUpNeeded?: boolean | null;
  followUpDate?: string | Date | null;
  expectedArrivalDate?: string | Date | null;
};

export const PURCHASE_REQUEST_GROUP_KEYS = ["openRequests", "orderedRequests", "receivedRequests", "sentRequests", "followUpRequests", "lateRequests"] as const;

export type PurchaseRequestGroupKey = (typeof PURCHASE_REQUEST_GROUP_KEYS)[number];

export type PurchaseRequestGroups<T extends PurchaseRequestLike> = Record<PurchaseRequestGroupKey, T[]>;

/** True when the date is strictly before today (local calendar day). */
export function isPastDate(value: unknown, now = new Date()): boolean {
  if (!value) return false;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

const CLOSED = ["received", "cancelled"];

export function groupPurchaseRequests<T extends PurchaseRequestLike>(purchaseRequests: readonly T[], now = new Date()): PurchaseRequestGroups<T> {
  return {
    openRequests: purchaseRequests.filter((req) => !CLOSED.includes(req.status)),
    orderedRequests: purchaseRequests.filter((req) => ["ordered", "partially_received"].includes(req.status)),
    receivedRequests: purchaseRequests.filter((req) => req.status === "received"),
    sentRequests: purchaseRequests.filter((req) => Boolean(req.sentAt)),
    followUpRequests: purchaseRequests.filter((req) => Boolean(req.followUpNeeded) || (Boolean(req.followUpDate) && isPastDate(req.followUpDate, now))),
    lateRequests: purchaseRequests.filter((req) => !CLOSED.includes(req.status) && Boolean(req.expectedArrivalDate) && isPastDate(req.expectedArrivalDate, now)),
  };
}
