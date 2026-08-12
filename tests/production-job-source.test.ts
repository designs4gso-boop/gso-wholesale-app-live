import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FAMILY_CHECKLISTS,
  advisoryLockKeys,
  buildShopifyOrderJobPayload,
  checklistForFamily,
  createProductionJobFromSource,
  familyFromQuoteItems,
  isConfiguratorLine,
  itemTicketFor,
  quoteConversionEligibility,
  suggestedFileNameForQuoteItem,
  validateQuoteSnapshotForConversion,
} from "../app/lib/production-job-source.server";

// ---------- fake Prisma with a REAL async advisory-lock simulation ----------
// $transaction(fn) runs fn(tx); tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock…")
// awaits an in-memory per-key mutex held until the transaction settles —
// modeling pg_advisory_xact_lock semantics so two CONCURRENT service calls
// are provably serialized through the same code path production uses.
function makeFakeDb() {
  const jobs: any[] = [];
  const quotes: any[] = [];
  const events: any[] = [];
  const files: any[] = [];
  const locks = new Map<string, Promise<void>>();
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

  function makeTx(release: { fn: (() => void) | null; key: string | null }) {
    return {
      async $queryRawUnsafe(sql: string) {
        const match = String(sql).match(/pg_advisory_xact_lock\((-?\d+), (-?\d+)\)/);
        if (!match) throw new Error("unexpected raw sql");
        const key = `${match[1]}:${match[2]}`;
        while (locks.has(key)) await locks.get(key);
        let releaseFn!: () => void;
        locks.set(key, new Promise<void>((resolve) => { releaseFn = resolve; }));
        release.key = key;
        release.fn = () => { locks.delete(key); releaseFn(); };
        return [];
      },
      productionJob: {
        findFirst: async ({ where }: any) =>
          jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
        count: async () => jobs.length,
        create: async ({ data }: any) => {
          const job = {
            id: nextId("job"),
            ...data,
            items: (data.items?.create || []).map((item: any) => ({ id: nextId("item"), ...item })),
            checklistItems: data.checklistItems?.create || [],
            events: data.events?.create || [],
          };
          jobs.push(job);
          for (const event of job.events) events.push({ jobId: job.id, ...event });
          return job;
        },
        update: async ({ where, data }: any) => {
          const job = jobs.find((row) => row.id === where.id);
          if (job) Object.assign(job, data);
          return job;
        },
      },
      quote: {
        findFirst: async ({ where }: any) => {
          const quote = quotes.find((row) => row.id === where.id && row.shop === where.shop) || null;
          return quote ? { ...quote, items: quote.items } : null;
        },
        updateMany: async ({ where, data }: any) => {
          for (const quote of quotes) {
            if (quote.id !== where.id || quote.shop !== where.shop) continue;
            if (where.status?.in && !where.status.in.includes(quote.status)) continue;
            Object.assign(quote, data);
          }
          return { count: 1 };
        },
      },
      productionJobFile: { create: async ({ data }: any) => { files.push(data); return data; } },
      productionJobEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    };
  }

  const db = {
    async $transaction(fn: (tx: any) => Promise<any>) {
      const release: { fn: (() => void) | null; key: string | null } = { fn: null, key: null };
      const tx = makeTx(release);
      try {
        return await fn(tx);
      } finally {
        if (release.fn) release.fn(); // lock released at transaction end (xact semantics)
      }
    },
    jobs, quotes, events, files,
  };
  return db;
}

const PAID_QUOTE = {
  id: "quoteA", shop: "shop1", status: "paid", customerName: "Jane", company: "JarCo",
  email: "j@x.com", phone: null, notes: "Quote notes",
  items: [{
    id: "qi1", productName: "150ml Miron jar + lid", variant: null, sku: null, quantity: 500,
    unitPrice: 9.5, unitCost: 4.1, recipeId: null, recipeName: null, selectedFinish: null,
    selectedAddOnIds: null, notes: null,
    costSnapshot: JSON.stringify({ engine: "14C.2-multilabel-auto-tiers", productBreakdown: { canonicalFamily: "premium-jars", missing: [] } }),
    priceSnapshot: JSON.stringify({ unitPrice: 9.5 }),
  }],
};

const DTP_BLOCKED_QUOTE = {
  ...PAID_QUOTE, id: "quoteDtpBlocked",
  items: [{ ...PAID_QUOTE.items[0], id: "qi2", costSnapshot: JSON.stringify({ productBreakdown: { canonicalFamily: "dtp-bags", missing: [], selections: { blank: "vendor:x" }, dtp: { size: "vendor:x" }, dtpPricing: { status: "BLOCKED", statusReasons: ["Blocked — selling price below cost"], overrideRequired: false } } }) }],
};

function dtpOverrideQuote(overrideReason: string | null) {
  return {
    ...PAID_QUOTE, id: `quoteDtpOverride_${overrideReason ? "with" : "without"}`,
    items: [{ ...PAID_QUOTE.items[0], id: "qi3", costSnapshot: JSON.stringify({ productBreakdown: { canonicalFamily: "dtp-bags", missing: [], selections: { blank: "vendor:x" }, dtp: { size: "vendor:x" }, dtpPricing: { status: "OWNER OVERRIDE REQUIRED", statusReasons: ["Below the 35% DTP hard margin floor"], overrideRequired: true, overrideReason } } }) }],
  };
}

describe("advisory-lock idempotency (15D.1-B)", () => {
  it("derives deterministic 32-bit lock keys from shop + source type + source id", () => {
    const [a1, b1] = advisoryLockKeys("shop1", "erp_quote", "quoteA");
    const [a2, b2] = advisoryLockKeys("shop1", "erp_quote", "quoteA");
    expect([a1, b1]).toEqual([a2, b2]);
    expect(advisoryLockKeys("shop1", "erp_quote", "quoteB")).not.toEqual([a1, b1]);
    expect(advisoryLockKeys("shop2", "erp_quote", "quoteA")).not.toEqual([a1, b1]);
    expect(Number.isInteger(a1) && Math.abs(a1) <= 2147483648).toBe(true);
  });

  it("sequential double conversion returns the existing job with created:false", async () => {
    const db = makeFakeDb();
    db.quotes.push(structuredClone(PAID_QUOTE));
    const first = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" } });
    const second = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(db.jobs).toHaveLength(1);
  });

  it("TWO CONCURRENT conversions create exactly one job (lock covers check+create)", async () => {
    const db = makeFakeDb();
    db.quotes.push(structuredClone(PAID_QUOTE));
    const [first, second] = await Promise.all([
      createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" } }),
      createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" } }),
    ]);
    expect(db.jobs).toHaveLength(1);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.job.id).toBe(second.job.id);
  });

  it("same Shopify webhook payload twice — sequential AND concurrent — yields one job", async () => {
    const db = makeFakeDb();
    const order = structuredClone(CONFIGURATOR_ORDER);
    const first = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "shopify_order", order } });
    const retry = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "shopify_order", order } });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.reason).toBe("Production job already exists.");
    expect(db.jobs).toHaveLength(1);
    const db2 = makeFakeDb();
    await Promise.all([
      createProductionJobFromSource(db2, { shop: "shop1", source: { type: "shopify_order", order: structuredClone(CONFIGURATOR_ORDER) } }),
      createProductionJobFromSource(db2, { shop: "shop1", source: { type: "shopify_order", order: structuredClone(CONFIGURATOR_ORDER) } }),
    ]);
    expect(db2.jobs).toHaveLength(1);
  });
});

describe("quote conversion validation (15D.1-C)", () => {
  it("refuses missing quote, wrong shop, draft, sent, and approved-but-unpaid quotes with exact reasons", async () => {
    expect(quoteConversionEligibility(null, "shop1").reason).toBe("Quote not found.");
    expect(quoteConversionEligibility({ ...PAID_QUOTE, shop: "other" }, "shop1").reason).toBe("Quote not found.");
    for (const status of ["draft", "sent", "approved"]) {
      expect(quoteConversionEligibility({ ...PAID_QUOTE, status }, "shop1").reason).toBe("Production can start only after the quote is fully paid.");
    }
    expect(quoteConversionEligibility({ ...PAID_QUOTE, status: "deposit_paid" }, "shop1").reason).toBe("Balance must be paid before production can start.");
    expect(quoteConversionEligibility(structuredClone(PAID_QUOTE), "shop1").ok).toBe(true);
    expect(quoteConversionEligibility({ ...structuredClone(PAID_QUOTE), status: "production" }, "shop1").ok).toBe(true);
  });

  it("refuses missing-cost snapshots and BLOCKED DTP quotes; DTP override requires a recorded written reason", async () => {
    const missingCost = [{ costSnapshot: JSON.stringify({ productBreakdown: { missing: ["GLOSS INK COST NOT VERIFIED"] } }) }];
    expect(validateQuoteSnapshotForConversion(missingCost).ok).toBe(false);
    expect(validateQuoteSnapshotForConversion(missingCost).reasons[0]).toContain("Missing costs");
    expect(validateQuoteSnapshotForConversion(DTP_BLOCKED_QUOTE.items).reasons[0]).toContain("BLOCKED");
    expect(validateQuoteSnapshotForConversion(dtpOverrideQuote(null).items).reasons[0]).toContain("override");
    expect(validateQuoteSnapshotForConversion(dtpOverrideQuote("  ").items).ok).toBe(false); // reason must be written, not whitespace
    expect(validateQuoteSnapshotForConversion(dtpOverrideQuote("strategic account entry").items).ok).toBe(true);
    // legacy/manual quote items without engine snapshots still convert
    expect(validateQuoteSnapshotForConversion([{ costSnapshot: null }]).ok).toBe(true);
    const db = makeFakeDb();
    db.quotes.push(structuredClone(DTP_BLOCKED_QUOTE));
    await expect(createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteDtpBlocked" } })).rejects.toThrow(/BLOCKED/);
    expect(db.jobs).toHaveLength(0);
  });

  it("valid paid quote converts: linked both ways, event written, status -> production, snapshot untouched", async () => {
    const db = makeFakeDb();
    db.quotes.push(structuredClone(PAID_QUOTE));
    const before = db.quotes[0].items[0].costSnapshot;
    const result = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" }, actor: "test_user" });
    expect(result.created).toBe(true);
    expect(result.job.quoteId).toBe("quoteA"); // job records source quote
    expect(db.quotes[0].status).toBe("production"); // lifecycle move
    expect(db.quotes[0].notes).toContain("[GSO] Production job "); // quote back-link
    expect(db.events.some((event) => event.eventType === "created_from_quote" && event.createdBy === "test_user")).toBe(true);
    expect(db.quotes[0].items[0].costSnapshot).toBe(before); // historical snapshot unchanged
    expect(result.job.items[0].costSnapshot).toBe(before); // complete commercial snapshot carried
  });
});

describe("tickets and naming (15D.1-A)", () => {
  it("every central-service job gets jobTicket, assetInboxKey, item tickets, rip names, and deterministic file names", async () => {
    const db = makeFakeDb();
    db.quotes.push(structuredClone(PAID_QUOTE));
    const { job } = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteA" } });
    expect(job.jobTicket).toMatch(/^GSO-\d{8}-\d{4}$/);
    expect(job.assetInboxKey).toBe(job.jobTicket);
    expect(job.items[0].itemTicket).toBe(`${job.jobTicket}-01`);
    expect(job.items[0].ripJobName).toBe(`${job.jobTicket}-01`);
    expect(job.items[0].suggestedFileName).toBe(suggestedFileNameForQuoteItem(job.jobTicket, PAID_QUOTE.items[0], 0));
    expect(itemTicketFor("GSO-20260724-0001", 1)).toBe("GSO-20260724-0001-02");
  });
});

describe("family checklists incl. DTP outsourced workflow (15D.1-D/G)", () => {
  it("maps snapshot families to their checklists; DTP has purchase steps and NO in-house print/machine/application", () => {
    expect(familyFromQuoteItems(PAID_QUOTE.items)).toBe("premium-jars");
    expect(familyFromQuoteItems(DTP_BLOCKED_QUOTE.items)).toBe("dtp-bags");
    expect(familyFromQuoteItems([{ costSnapshot: null }])).toBe("default");
    expect(familyFromQuoteItems([{ costSnapshot: JSON.stringify({ productBreakdown: { canonicalFamily: "bags-4x5" } }) }])).toBe("sticker-bags");
    const dtp = checklistForFamily("dtp-bags").map((step) => step.label);
    for (const step of ["Artwork received", "Artwork reviewed", "Purchase order prepared", "Purchase order sent to Spektra", "Vendor proof received", "Customer proof approved", "Order confirmed", "Expected delivery recorded", "Goods received", "Quality control", "Customer delivery / pickup", "Complete"]) {
      expect(dtp).toContain(step);
    }
    const dtpText = dtp.join(" ").toLowerCase();
    for (const banned of ["print complete", "machine", "applied", "weed", "material pulled"]) expect(dtpText).not.toContain(banned);
    expect(checklistForFamily("premium-jars").map((s) => s.label).join(" ")).toContain("Miron top type");
    expect(checklistForFamily("nonsense")).toEqual(FAMILY_CHECKLISTS.default);
  });

  it("a paid DTP quote converts with the Spektra purchase checklist and its dtp/dtpPricing snapshot intact", async () => {
    const db = makeFakeDb();
    db.quotes.push(structuredClone(dtpOverrideQuote("strategic account entry")));
    const { job } = await createProductionJobFromSource(db, { shop: "shop1", source: { type: "erp_quote", quoteId: "quoteDtpOverride_with" } });
    expect(job.checklistItems.map((step: any) => step.label)).toContain("Purchase order sent to Spektra");
    const snapshot = JSON.parse(job.items[0].costSnapshot);
    expect(snapshot.productBreakdown.dtpPricing.overrideReason).toBe("strategic account entry");
  });
});

// ---------- Shopify webhook output-equivalence fixture (15D.1-F) ----------
const CONFIGURATOR_ORDER = {
  id: 987654321,
  admin_graphql_api_id: "gid://shopify/Order/987654321",
  name: "#1042",
  note: "",
  email: "buyer@example.com",
  phone: "",
  tags: "",
  customer: { first_name: "Sam", last_name: "Buyer", email: "buyer@example.com" },
  billing_address: { first_name: "Sam", last_name: "Buyer", company: "BuyCo", phone: "555-0100" },
  line_items: [
    {
      id: 111, title: "Stock Bag 4x5 - Matte/Glossy/Black", sku: "SB-4X5", quantity: 1000,
      price: "0.55", product_id: 222, variant_id: 333,
      properties: [
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "Glossy" },
        { name: "Production Finish", value: "Spot Gloss" },
        { name: "Bag Color", value: "Black" },
        { name: "Sides", value: "Double Sided" },
        { name: "Product Family", value: "Stock Bags" },
        { name: "Product Type", value: "stock_bag_4x5" },
      ],
    },
    { id: 112, title: "Unrelated line", quantity: 1, price: "5.00", properties: [] },
  ],
};

describe("Shopify webhook parity (15D.1-F)", () => {
  it("the central builder reproduces the recorded configurator mapping field-for-field", () => {
    const payload = buildShopifyOrderJobPayload(CONFIGURATOR_ORDER, "GSO-20260724-0001")!;
    expect(payload.quoteId).toBe("shopify_order_gid://shopify/Order/987654321"); // pseudo-quoteId convention
    expect(payload.quoteNumber).toBe("#1042");
    expect(payload.customerName).toBe("Sam Buyer");
    expect(payload.company).toBe("BuyCo");
    expect(payload.email).toBe("buyer@example.com");
    expect(payload.phone).toBe("555-0100");
    // 15H.4A: deliberate pin update — internalNotes now also carries the
    // source marker + first-class order GID (spec L metadata).
    expect(payload.internalNotes).toContain("Created automatically from paid Shopify configurator order #1042.");
    expect(payload.internalNotes).toContain("Source: paid_shopify_order | Order GID: ");
    expect(payload.items).toHaveLength(1); // non-configurator line excluded
    const item = payload.items[0];
    expect(item.productTitle).toBe("Stock Bag 4x5"); // title suffix stripped
    expect(item.variantTitle).toBe("Matte / Glossy / Black");
    expect(item.sku).toBe("SB-4X5");
    expect(item.quantity).toBe(1000);
    expect(item.unitPrice).toBe(0.55);
    expect(item.unitCost).toBe(0);
    expect(item.shopifyProductGid).toBe("gid://shopify/Product/222");
    expect(item.shopifyVariantGid).toBe("gid://shopify/ProductVariant/333");
    expect(item.selectedFinish).toBe("Spot Gloss");
    expect(item.itemTicket).toBe("GSO-20260724-0001-01");
    expect(item.ripJobName).toBe("GSO-20260724-0001-01");
    expect(item.suggestedFileName).toBe("GSO-20260724-0001-01_STOCK-BAG-4X5_SPOT-GLOSS_BLACK_QTY1000");
    expect(item.materialSummary).toBe("Material: Matte | Finish: Glossy | Production Finish: Spot Gloss | Bag Color: Black | Sides: Double Sided");
    const price = JSON.parse(item.priceSnapshot);
    expect(price.source).toBe("shopify_order_paid_webhook");
    expect(price.lineTotal).toBe(550);
    const cost = JSON.parse(item.costSnapshot);
    expect(cost.source).toBe("pending_cost_book_mapping");
    expect(JSON.parse(item.selectedAddOns)).toEqual({ productFamily: "Stock Bags", productType: "stock_bag_4x5", material: "Matte", finish: "Glossy", productionFinish: "Spot Gloss", bagColor: "Black", sides: "Double Sided" });
    expect(isConfiguratorLine(CONFIGURATOR_ORDER.line_items[0])).toBe(true);
    expect(isConfiguratorLine(CONFIGURATOR_ORDER.line_items[1])).toBe(false);
    // order with no configurator lines -> no job
    expect(buildShopifyOrderJobPayload({ line_items: [CONFIGURATOR_ORDER.line_items[1]] }, "GSO-X")).toBeNull();
  });
});

describe("route consolidation pins (15D.1-E/F/H)", () => {
  const quotesSrc = readFileSync(new URL("../app/routes/app.quotes.tsx", import.meta.url), "utf8");
  const productionSrc = readFileSync(new URL("../app/routes/app.erp.production.tsx", import.meta.url), "utf8");
  const webhookSrc = readFileSync(new URL("../app/routes/webhooks.orders_paid.tsx", import.meta.url), "utf8");

  it("all three paths call the central service; local duplicate creators are gone", () => {
    for (const src of [quotesSrc, productionSrc, webhookSrc]) expect(src).toContain("createProductionJobFromSource(db,");
    expect(quotesSrc).not.toContain("const existingJob = await db.productionJob.findFirst"); // old local creator body removed
    expect(productionSrc).not.toContain("Created from quote.\",");
    expect(webhookSrc).not.toContain("createProductionJobFromConfiguratorOrder");
    expect(webhookSrc).not.toContain("buildNextJobTicket"); // creator helpers moved to the service
    // payment branch preserved verbatim
    for (const marker of ["[GSO] Deposit invoice paid", "[GSO] Balance invoice paid", "[GSO] Full payment invoice paid", "classifyQuotePaymentOrder", "status ${quote.status} preserved"]) {
      expect(webhookSrc).toContain(marker);
    }
  });

  it("advisory lock is real SQL inside the transaction; UI shows disabled reasons and source links", () => {
    const serviceSrc = readFileSync(new URL("../app/lib/production-job-source.server.ts", import.meta.url), "utf8");
    expect(serviceSrc).toContain("pg_advisory_xact_lock");
    expect(serviceSrc).toContain("$transaction(async (tx: any) =>");
    expect(serviceSrc.indexOf("acquireSourceLock(tx")).toBeLessThan(serviceSrc.indexOf("tx.productionJob.findFirst")); // lock BEFORE check
    expect(quotesSrc).toContain("Production: balance must be paid first");
    expect(quotesSrc).toContain("Production: available after full payment");
    expect(productionSrc).toContain("Source: {String(job.quoteId");
  });
});
