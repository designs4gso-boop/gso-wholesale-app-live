// 2026-11-11 OWNER RULES — storefront / quote safety closeout.
//
// - Paid orders: if the raw-variant (configurator bypass) lookup fails, no
//   production job is created; the webhook returns 503 so Shopify retries.
// - Deposits: 50% standard; any other percentage is an explicit owner change
//   (1-99%). No Net terms.
// - Quote snapshots are immutable once a deposit is paid / paid / in
//   production / completed.
// - DTP quoting never uses the historical $85 freight.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPEKTRA_FREIGHT_ASSUMPTION } from "../app/lib/dtp-catalog";

const webhook = readFileSync("app/routes/webhooks.orders_paid.tsx", "utf8");
const quotes = readFileSync("app/routes/app.quotes.tsx", "utf8");
const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");

describe("paid-order webhook fails closed on the configurator-bypass lookup", () => {
  it("a lookup error returns 503 before any production job is created", () => {
    const check = webhook.indexOf('console.error("orders_paid configurator-bypass check failed');
    const create = webhook.indexOf("createProductionJobFromSource(db, {");
    expect(check).toBeGreaterThan(0);
    expect(webhook.slice(check, check + 300)).toContain('return new Response("Configurator bypass check unavailable — retry", { status: 503 });');
    expect(check).toBeLessThan(create);
  });
});

describe("deposit percent", () => {
  it("standard 50%; non-standard needs the owner; out-of-range refused", () => {
    expect(quotes).toContain("const STANDARD_DEPOSIT_PERCENT = 50;");
    expect(quotes).toContain("if (!Number.isFinite(requestedDeposit) || requestedDeposit < 1 || requestedDeposit > 99)");
    expect(quotes).toContain("if (requestedDeposit !== STANDARD_DEPOSIT_PERCENT && !resolveOwnerAuthorization({ session, sessionToken }).isOwner)");
    expect(quotes).not.toContain("Number(payload.depositPercent) || 50");
  });
});

describe("quote snapshot immutability", () => {
  it("saves are refused for deposit_paid / paid / production / completed quotes", () => {
    expect(quotes).toContain('const LOCKED_QUOTE_STATUSES = ["deposit_paid", "paid", "production", "completed"];');
    expect(quotes).toContain('if (LOCKED_QUOTE_STATUSES.includes(String(existingQuote?.status || "")))');
  });
});

describe("DTP freight", () => {
  it("quoting never uses the historical $85; the marker says so", () => {
    expect(SPEKTRA_FREIGHT_ASSUMPTION.note).toContain("NOT used in DTP quoting");
    expect(calc).toContain("Freight: not included in this true cost (actual / vendor quote / manual entry only)");
    expect(calc).not.toContain("Freight: ${money2(SPEKTRA_FREIGHT_ASSUMPTION.amount)} / UNVERIFIED");
    expect(calc).toContain('freightSource: "excluded" as const');
  });
});
