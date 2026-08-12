// Phase 15H.4A — Shopify paid-order production convergence.
// Pins: canonical `_GSO Canonical` consumption (authoritative production
// config), first-class orderGid (capability-guarded staged column), webhook
// idempotency, multi-line behavior, unsupported-line safety, and intake
// reuse of the resulting tickets.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildShopifyOrderJobPayload,
  createProductionJobFromSource,
} from "../app/lib/production-job-source.server";
import {
  canonicalLineWarnings,
  parseCanonicalOrderLine,
  orderGidColumnAvailable,
  resetOrderGidCapabilityForTests,
} from "../app/lib/order-canonical.server";
import { decideIntakeRoute } from "../app/lib/print-intake-routing.server";

const CANONICAL = {
  v: "15G.5-storefront-canonical",
  profile: "stock_bag_4x5",
  qty: 500,
  faces: 2,
  material: "Matte",
  bagColor: "White",
  holo: false,
  whiteRequired: false,
  glossX: 3,
  finishLabel: "Raised Gloss+ — 3X",
  unitPrice: 1.92,
  engine: "canonical-bag-pricing/15G.4C",
};

function canonicalLine(overrides: Record<string, unknown> = {}, canonicalOverrides: Record<string, unknown> = {}) {
  return {
    id: 111,
    title: "Ritz Vanilla Cupcake - Matte / Raised Gloss+ — 3X / White",
    quantity: 500,
    price: "1.92",
    sku: "",
    product_id: 42,
    variant_id: 43,
    properties: [
      { name: "Product Family", value: "Stock Bags" },
      { name: "Product Type", value: "stock_bag_4x5" },
      { name: "Material", value: "Matte" },
      { name: "Finish", value: "Raised Gloss+ — 3X" },
      { name: "Bag Color", value: "White" },
      { name: "Sides", value: "Double Sided" },
      { name: "_GSO Canonical", value: JSON.stringify({ ...CANONICAL, ...canonicalOverrides }) },
    ],
    ...overrides,
  };
}

function paidOrder(lines: any[], overrides: Record<string, unknown> = {}) {
  return {
    admin_graphql_api_id: "gid://shopify/Order/999001",
    id: 999001,
    name: "#2001",
    email: "customer@example.com",
    customer: { first_name: "Test", last_name: "Buyer" },
    line_items: lines,
    ...overrides,
  };
}

function fakeDb(seedJobs: any[] = [], { orderGidColumn = true } = {}) {
  const jobs = [...seedJobs];
  const creates: any[] = [];
  let id = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    productionJob: {
      count: async () => jobs.length,
      findFirst: async ({ where }: any) => jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
      create: async ({ data }: any) => {
        const job = { id: `job_${++id}`, ...data, items: (data.items?.create || []).map((item: any, i: number) => ({ id: `item_${i}`, ...item })) };
        jobs.push(job);
        creates.push(data);
        return job;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.find((row) => row.id === where.id);
        if (job) Object.assign(job, data);
        return job;
      },
    },
    productionJobFile: { create: async () => ({}) },
    productionJobEvent: { create: async () => ({}) },
    quote: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    printIntake: { findUnique: async () => null, create: async ({ data }: any) => ({ id: "pi", ...data }), update: async ({ data }: any) => ({ id: "pi", ...data }) },
  };
  const db = {
    $transaction: async (fn: any) => fn(tx),
    // capability probe target: succeeds only when the staged column "exists"
    $queryRawUnsafe: async (sql: string) => {
      if (/orderGid/.test(sql) && !orderGidColumn) throw new Error('column "orderGid" does not exist');
      return [];
    },
    printIntake: tx.printIntake,
  };
  return { db, jobs, creates };
}

beforeEach(() => resetOrderGidCapabilityForTests());

describe("15H.4A order convergence foundation", () => {
  it("3+E. parses the exact canonical shape and rejects malformed snapshots fail-closed", () => {
    const parsed = parseCanonicalOrderLine(JSON.stringify(CANONICAL));
    expect(parsed).toMatchObject({ profile: "stock_bag_4x5", qty: 500, faces: 2, glossX: 3, unitPrice: 1.92, engine: "canonical-bag-pricing/15G.4C" });
    expect(parseCanonicalOrderLine("not json")).toBeNull();
    expect(parseCanonicalOrderLine(JSON.stringify({ ...CANONICAL, qty: 0 }))).toBeNull();
    expect(parseCanonicalOrderLine(JSON.stringify({ ...CANONICAL, faces: 3 }))).toBeNull();
    expect(parseCanonicalOrderLine(JSON.stringify({ ...CANONICAL, unitPrice: -1 }))).toBeNull();
  });

  it("6-15. canonical fields map authoritatively onto the production item", () => {
    const payload = buildShopifyOrderJobPayload(
      paidOrder([canonicalLine({}, { holo: true, whiteRequired: true })]),
      "GSO-20260812-0001",
    )!;
    expect(payload.orderGid).toBe("gid://shopify/Order/999001");
    const item = payload.items[0];
    expect(item.quantity).toBe(500);
    expect(item.unitPrice).toBe(1.92); // canonical engine-stamped price preserved
    expect(item.variantTitle).toContain("Matte");
    expect(item.selectedFinish).toBe("Raised Gloss+ — 3X");
    const addOns = JSON.parse(item.selectedAddOns);
    expect(addOns).toMatchObject({
      source: "gso_canonical_checkout",
      material: "Matte",
      bagColor: "White",
      sides: "Double Sided",
      faces: 2,
      holographic: true,
      requiredWhite: true,
      glossLayers: 3,
      engine: "canonical-bag-pricing/15G.4C",
    });
    expect(item.materialSummary).toContain("Gloss Layers: 3X");
    expect(item.materialSummary).toContain("White Layers: 1");
    expect(item.materialSummary).toContain("Holographic: yes");
    const snapshot = JSON.parse(item.priceSnapshot);
    expect(snapshot.canonical).toMatchObject({ v: "15G.5-storefront-canonical", engine: "canonical-bag-pricing/15G.4C", qty: 500 });
    expect(snapshot.linePaidUnitPrice).toBe(1.92);
    // production notes carry the specialty facts for the shop floor
    expect(item.productionNotes).toContain("Gloss Layers: 3X");
  });

  it("K. canonical/paid mismatches surface as warnings, never recalculation", () => {
    expect(canonicalLineWarnings(parseCanonicalOrderLine(JSON.stringify(CANONICAL))!, { quantity: 500, unitPrice: 1.92 })).toEqual([]);
    const warnings = canonicalLineWarnings(parseCanonicalOrderLine(JSON.stringify(CANONICAL))!, { quantity: 400, unitPrice: 2.5 });
    expect(warnings).toHaveLength(2);
    const payload = buildShopifyOrderJobPayload(paidOrder([canonicalLine({ quantity: 400, price: "2.50" })]), "GSO-20260812-0002")!;
    expect(payload.items[0].productionNotes).toContain("WARNING:");
    expect(payload.items[0].quantity).toBe(400); // paid line quantity stays the commercial record
  });

  it("legacy lines without a canonical snapshot keep the byte-identical pre-15H.4A mapping", () => {
    const legacy = canonicalLine();
    legacy.properties = legacy.properties.filter((prop: any) => prop.name !== "_GSO Canonical");
    const payload = buildShopifyOrderJobPayload(paidOrder([legacy]), "GSO-20260812-0003")!;
    const item = payload.items[0];
    expect(item.materialSummary).toBe("Material: Matte | Finish: Raised Gloss+ — 3X | Production Finish: Raised Gloss+ — 3X | Bag Color: White | Sides: Double Sided");
    expect(JSON.parse(item.priceSnapshot).canonical).toBeUndefined();
    expect(item.unitPrice).toBe(1.92);
  });

  it("1+2+17+16+H. one order -> ONE job; per-line items with unique -01/-02 tickets; orderGid written when the column exists", async () => {
    const { db, creates } = fakeDb([], { orderGidColumn: true });
    const secondLine = canonicalLine({ id: 222, title: "Second Bag - Holo", quantity: 100, price: "2.58" }, { qty: 100, material: "Holographic", holo: true, whiteRequired: true, glossX: 0, finishLabel: "No Specialty — 0X", unitPrice: 2.58 });
    const result = await createProductionJobFromSource(db, {
      shop: "shop.test",
      source: { type: "shopify_order", order: paidOrder([canonicalLine(), secondLine]) },
    });
    expect(result.created).toBe(true);
    expect(creates).toHaveLength(1); // ONE ProductionJob
    expect(creates[0].orderGid).toBe("gid://shopify/Order/999001");
    const tickets = creates[0].items.create.map((item: any) => item.itemTicket);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets).size).toBe(2);
    expect(tickets[0]).toMatch(/^GSO-\d{8}-\d{4}-01$/);
    expect(tickets[1]).toMatch(/^GSO-\d{8}-\d{4}-02$/);
  });

  it("capability guard: before the staged column is activated, orderGid is NOT written and creation still succeeds", async () => {
    const { db, creates } = fakeDb([], { orderGidColumn: false });
    const result = await createProductionJobFromSource(db, { shop: "shop.test", source: { type: "shopify_order", order: paidOrder([canonicalLine()]) } });
    expect(result.created).toBe(true);
    expect("orderGid" in creates[0]).toBe(false);
  });

  it("3+24+G. webhook retry and simultaneous delivery: same order -> same job, no duplicate", async () => {
    const { db, creates } = fakeDb();
    const source = { type: "shopify_order" as const, order: paidOrder([canonicalLine()]) };
    const first = await createProductionJobFromSource(db, { shop: "shop.test", source });
    const retry = await createProductionJobFromSource(db, { shop: "shop.test", source });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
    expect(creates).toHaveLength(1);
  });

  it("5. missing order GID fails closed (no unstable fallback)", async () => {
    await expect(
      createProductionJobFromSource({} as any, { shop: "shop.test", source: { type: "shopify_order", order: { line_items: [canonicalLine()] } } }),
    ).rejects.toThrow(/stable order identity/);
  });

  it("18+I. unsupported lines never fabricate production specs — omitted and logged", () => {
    const unsupported = { id: 333, title: "Gift Card", quantity: 1, price: "25.00", properties: [] };
    const payload = buildShopifyOrderJobPayload(paidOrder([canonicalLine(), unsupported]), "GSO-20260812-0004")!;
    expect(payload.items).toHaveLength(1);
    expect(payload.skippedLines).toEqual(["Gift Card x1"]);
    expect(payload.internalNotes).toContain("non-production line(s) omitted");
    const onlyUnsupported = buildShopifyOrderJobPayload(paidOrder([unsupported]), "GSO-20260812-0005");
    expect(onlyUnsupported).toBeNull();
  });

  it("19+J. intake resolves the resulting job by item ticket, job ticket, and suggested filename", () => {
    const payload = buildShopifyOrderJobPayload(paidOrder([canonicalLine()]), "GSO-20260812-0006")!;
    const intakeJob = {
      id: "job1",
      jobTicket: "GSO-20260812-0006",
      customerName: payload.customerName,
      company: null,
      status: "new",
      artworkUrl: null,
      printFileUrl: null,
      items: payload.items.map((item: any, index: number) => ({
        id: `item_${index}`,
        itemTicket: item.itemTicket,
        ripJobName: item.ripJobName,
        suggestedFileName: item.suggestedFileName,
        productTitle: item.productTitle,
        selectedFinish: item.selectedFinish,
        materialSummary: item.materialSummary,
        machineSummary: null,
      })),
      fileNames: [],
    };
    const byItemTicket = decideIntakeRoute({ fileName: `${payload.items[0].itemTicket}_artwork.pdf`, jobs: [intakeJob] });
    expect(byItemTicket.decision).toBe("route");
    expect(byItemTicket.machine).toBe("roland"); // 3X gloss in the canonical summary routes Roland
    const byJobTicket = decideIntakeRoute({ fileName: "GSO-20260812-0006 final.pdf", jobs: [intakeJob] });
    expect(byJobTicket.decision).toBe("route");
    const bySuggested = decideIntakeRoute({ fileName: `${payload.items[0].suggestedFileName}.pdf`, jobs: [intakeJob] });
    expect(bySuggested.decision).toBe("route");
  });

  it("holo canonical orders route Roland via the explicit white token in the summary", () => {
    const payload = buildShopifyOrderJobPayload(
      paidOrder([canonicalLine({}, { material: "Holographic", holo: true, whiteRequired: true, glossX: 0, finishLabel: "No Specialty — 0X" })]),
      "GSO-20260812-0007",
    )!;
    const intakeJob = {
      id: "j", jobTicket: "GSO-20260812-0007", customerName: null, company: null, status: "new", artworkUrl: null, printFileUrl: null,
      items: [{ id: "i", itemTicket: payload.items[0].itemTicket, ripJobName: payload.items[0].ripJobName, suggestedFileName: payload.items[0].suggestedFileName, productTitle: "x", selectedFinish: payload.items[0].selectedFinish, materialSummary: payload.items[0].materialSummary, machineSummary: null }],
      fileNames: [],
    };
    const route = decideIntakeRoute({ fileName: `${payload.items[0].itemTicket}.pdf`, jobs: [intakeJob] });
    expect(route.machine).toBe("roland");
    expect(route.machineRule).toBe("white_or_gloss");
  });

  it("20-23. checkout emitter, RIP matcher, routing rules, and pricing files untouched", () => {
    const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");
    expect(checkout).toContain('"_GSO Canonical"');
    expect(checkout).toContain("originalUnitPriceWithCurrency");
    const emitter = readFileSync("app/lib/storefront-canonical-pricing.server.ts", "utf8");
    expect(emitter).toContain('engine: "canonical-bag-pricing/15G.4C"');
    const matcher = readFileSync("app/lib/rip-identity-match.server.ts", "utf8");
    expect(matcher).toContain("exact_item_ticket");
    const routing = readFileSync("app/lib/print-intake-routing.server.ts", "utf8");
    expect(routing).toContain('reasons: ["default_cmyk_to_mimaki"]');
  });

  it("capability probe caches and resets cleanly", async () => {
    const failing = { $queryRawUnsafe: async () => { throw new Error("no column"); } };
    expect(await orderGidColumnAvailable(failing)).toBe(false);
    expect(await orderGidColumnAvailable({ $queryRawUnsafe: async () => [] })).toBe(false); // cached
    resetOrderGidCapabilityForTests();
    expect(await orderGidColumnAvailable({ $queryRawUnsafe: async () => [] })).toBe(true);
  });
});
