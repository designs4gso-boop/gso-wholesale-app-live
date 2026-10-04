// Hotfix 2026-10-04 — `/app/erp/purchase-requests` threw
// `ReferenceError: sentRequests is not defined` because the loader returned
// six request groups while the component destructured only three and then
// read the other three as bare identifiers. These tests pin (a) the grouping
// itself for zero and mock requests and (b) the loader/component contract in
// the route source, so a future divergence fails here instead of in a browser.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PURCHASE_REQUEST_GROUP_KEYS, groupPurchaseRequests, isPastDate } from "../app/lib/purchase-request-groups";

const now = new Date("2026-10-04T12:00:00");

describe("purchase request grouping", () => {
  it("renders every group as an empty array when there are zero requests", () => {
    const groups = groupPurchaseRequests([], now);
    expect(Object.keys(groups).sort()).toEqual([...PURCHASE_REQUEST_GROUP_KEYS].sort());
    for (const key of PURCHASE_REQUEST_GROUP_KEYS) expect(groups[key]).toEqual([]);
    for (const key of PURCHASE_REQUEST_GROUP_KEYS) expect(groups[key].length).toBe(0); // the badge expression `x.length`
  });

  it("groups mock requests without referencing undefined values", () => {
    const rows = [
      { id: "a", status: "draft" },
      { id: "b", status: "requested", sentAt: "2026-10-01T00:00:00Z", followUpNeeded: true },
      { id: "c", status: "ordered", sentAt: "2026-09-20T00:00:00Z", expectedArrivalDate: "2026-09-30" },
      { id: "d", status: "partially_received", followUpDate: "2026-10-01" },
      { id: "e", status: "received", sentAt: "2026-09-01T00:00:00Z", expectedArrivalDate: "2026-09-10" },
      { id: "f", status: "cancelled", expectedArrivalDate: "2026-01-01" },
      { id: "g", status: "requested", expectedArrivalDate: "2026-12-01", followUpDate: "2026-12-01" },
    ];
    const g = groupPurchaseRequests(rows, now);
    const ids = (k: keyof typeof g) => g[k].map((r) => r.id);
    expect(ids("openRequests")).toEqual(["a", "b", "c", "d", "g"]);
    expect(ids("orderedRequests")).toEqual(["c", "d"]);
    expect(ids("receivedRequests")).toEqual(["e"]);
    expect(ids("sentRequests")).toEqual(["b", "c", "e"]);
    expect(ids("followUpRequests")).toEqual(["b", "d"]);
    expect(ids("lateRequests")).toEqual(["c"]); // received/cancelled never late; future dates not late
    expect(isPastDate("2026-10-03", now)).toBe(true);
    expect(isPastDate("2026-10-04T12:00:00", now)).toBe(false); // same local day is not past
    expect(isPastDate("2026-10-05T00:00:00", now)).toBe(false);
    expect(isPastDate(null, now)).toBe(false);
    expect(isPastDate("not a date", now)).toBe(false);
  });

  it("the route component destructures every group key the loader returns", () => {
    const source = readFileSync(new URL("../app/routes/app.erp.purchase-requests.tsx", import.meta.url), "utf8");
    const destructure = source.match(/const \{([^}]+)\} = useLoaderData<any>\(\);/);
    expect(destructure, "component must destructure loader data").toBeTruthy();
    const names = destructure![1].split(",").map((s) => s.trim());
    for (const key of PURCHASE_REQUEST_GROUP_KEYS) expect(names, `component must destructure ${key}`).toContain(key);
    expect(source).toContain("...groupPurchaseRequests(purchaseRequests)");
    // every `<something>Requests` identifier used in JSX must be destructured
    const used = new Set(Array.from(source.matchAll(/\b([a-z]+Requests)\b/g)).map((m) => m[1]));
    for (const name of used) if (name !== "purchaseRequests") expect(PURCHASE_REQUEST_GROUP_KEYS as readonly string[], `unexpected group identifier ${name}`).toContain(name);
  });
});
