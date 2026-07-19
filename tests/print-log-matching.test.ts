import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MATCH_ENTRY_RETIRED_MESSAGE,
  PRINT_LOG_REVIEW_PATH,
  decidePrintLogMatch,
  printLogTicketWhere,
} from "../app/lib/print-log-matching.server";

const routeSource = readFileSync(new URL("../app/routes/app.erp.print-logs.tsx", import.meta.url), "utf8");

describe("conservative print-log matching (13A.6E)", () => {
  it("exactly one exact candidate attaches", () => {
    expect(decidePrintLogMatch([{ id: "job1" }])).toEqual({ productionJobId: "job1", ambiguous: false });
  });

  it("duplicate exact candidates are ambiguous — never first-match-wins", () => {
    const decision = decidePrintLogMatch([{ id: "job1" }, { id: "job2" }]);
    expect(decision.productionJobId).toBeNull();
    expect(decision.ambiguous).toBe(true);
  });

  it("zero candidates stay unresolved", () => {
    expect(decidePrintLogMatch([])).toEqual({ productionJobId: null, ambiguous: false });
  });

  it("cross-shop isolation: the candidate query always embeds the shop and the exact ticket", () => {
    expect(printLogTicketWhere("shop-a.myshopify.com", "GSO-123")).toEqual({ shop: "shop-a.myshopify.com", jobTicket: "GSO-123" });
    expect(printLogTicketWhere("shop-a.myshopify.com", "GSO-123")).not.toEqual(printLogTicketWhere("shop-b.myshopify.com", "GSO-123"));
  });
});

describe("print-logs route safety (source-pinned regressions)", () => {
  it("contains-only matching is gone from the page — no bare contains attachment remains", () => {
    expect(routeSource).not.toMatch(/jobTicket:\s*\{\s*contains/);
    expect(routeSource).not.toMatch(/sourceJobName\.includes\(/);
  });

  it("the retired matchEntry intent no longer mutates source values (no jobTicket overwrite)", () => {
    expect(routeSource).not.toContain("jobTicket: job.jobTicket || entry.jobTicket");
    expect(routeSource).toContain("MATCH_ENTRY_RETIRED_MESSAGE");
  });

  it("unresolved rows direct the operator to the review page", () => {
    expect(routeSource).toContain(PRINT_LOG_REVIEW_PATH);
    expect(MATCH_ENTRY_RETIRED_MESSAGE).toContain(PRINT_LOG_REVIEW_PATH);
  });

  it("import-time matching goes through the conservative decision helper", () => {
    expect(routeSource).toContain("decidePrintLogMatch");
    expect(routeSource).toContain("printLogTicketWhere");
  });
});
