// Stock Bag personalization — Phase 5 paid order -> production.
//
// End-to-end through the REAL central service against a fake Prisma client that
// models pg_advisory_xact_lock semantics (same approach as
// tests/production-job-source.test.ts), plus pure-function tests for the
// attribute reader and source pins for the invariants that must not drift.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildShopifyOrderJobPayload,
  createProductionJobFromSource,
  decodeOrderPersonalization,
} from "../app/lib/production-job-source.server";
import {
  PERSONALIZATION_ASSET_ROLE,
  PERSONALIZATION_ASSET_SOURCE,
  PERSONALIZATION_FAILED_URL_PREFIX,
  PERSONALIZATION_PENDING_URL_PREFIX,
  pairPersonalizationFileNames,
  personalizationFallbackName,
  readPersonalizationFromLine,
} from "../app/lib/personalization-production.server";
import { personalizationLineAttributes } from "../app/lib/personalization-claim.server";
import { sanitizeOriginalFileName } from "../app/lib/personalization-assets.server";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const A = "gid://shopify/MediaImage/1111111111";
const B = "gid://shopify/MediaImage/2222222222";
const PDF = "gid://shopify/GenericFile/33";

const CANONICAL_BAG = JSON.stringify({
  v: "15G.4C",
  profile: "stock_bag_4x5",
  qty: 50,
  faces: 2,
  material: "Matte",
  bagColor: "Kraft",
  holo: false,
  whiteRequired: false,
  glossX: 0,
  finishLabel: "Standard",
  unitPrice: 1.25,
  engine: "canonical-bag-pricing/15G.4C",
});

const CANONICAL_JAR = JSON.stringify({
  v: "16D",
  family: "jars",
  profile: "jar_100ml_miron",
  qty: 50,
  size: "100ml",
  baseFinish: "Matte",
  labelMaterial: "Standard",
  finishLabel: "Standard",
  specialtyX: 0,
  holo: false,
  whiteRequired: false,
  unitPrice: 4.5,
  engine: "canonical-jar-pricing/16D",
});

/** Build the personalization attributes exactly the way Phase 4 does. */
function attrs(assets: Array<{ assetId: string; originalFileName: string; status: "READY" | "PROCESSING" }>) {
  return personalizationLineAttributes(assets).map((a) => ({ name: a.key, value: a.value }));
}

function bagLine(
  overrides: {
    id?: number;
    assets?: Array<{ assetId: string; originalFileName: string; status: "READY" | "PROCESSING" }>;
    extraProps?: Array<{ name: string; value: string }>;
    canonical?: string;
    title?: string;
  } = {},
) {
  return {
    id: overrides.id ?? 9001,
    title: overrides.title ?? "4x5 Stock Bag - Matte / Standard / Kraft",
    quantity: 50,
    price: "1.25",
    properties: [
      { name: "_GSO Canonical", value: overrides.canonical ?? CANONICAL_BAG },
      { name: "Product Family", value: "Stock Bags" },
      { name: "Material", value: "Matte" },
      { name: "Finish", value: "Standard" },
      { name: "Bag Color", value: "Kraft" },
      ...(overrides.assets ? attrs(overrides.assets) : []),
      ...(overrides.extraProps ?? []),
    ],
  };
}

function order(lines: any[], id = 555000111) {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: "#1001",
    email: "buyer@example.com",
    line_items: lines,
  };
}

/* ------------------------------------------------------------------ *
 * Fake Prisma (advisory-lock semantics preserved)
 * ------------------------------------------------------------------ */

function makeFakeDb() {
  const jobs: any[] = [];
  const events: any[] = [];
  const files: any[] = [];
  const locks = new Map<string, Promise<void>>();
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

  function makeTx(release: { fn: (() => void) | null }) {
    return {
      async $queryRawUnsafe(sql: string) {
        const match = String(sql).match(/pg_advisory_xact_lock\((-?\d+), (-?\d+)\)/);
        if (!match) throw new Error("unexpected raw sql");
        const key = `${match[1]}:${match[2]}`;
        while (locks.has(key)) await locks.get(key);
        let releaseFn!: () => void;
        locks.set(key, new Promise<void>((resolve) => { releaseFn = resolve; }));
        release.fn = () => { locks.delete(key); releaseFn(); };
        return [];
      },
      productionJob: {
        findFirst: async ({ where }: any) => jobs.find((job) => Object.entries(where).every(([k, v]) => job[k] === v)) || null,
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
      quote: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
      productionJobFile: { create: async ({ data }: any) => { files.push(data); return data; } },
      productionJobEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    };
  }

  return {
    async $transaction(fn: (tx: any) => Promise<any>) {
      const release: { fn: (() => void) | null } = { fn: null };
      const tx = makeTx(release);
      try {
        return await fn(tx);
      } finally {
        if (release.fn) release.fn();
      }
    },
    // orderGidColumnAvailable probes this on the top-level client
    async $queryRawUnsafe() { throw new Error("no such column"); },
    jobs, events, files,
  } as any;
}

/** Resolver stand-in. `statuses` is keyed by asset id; arrays advance per call. */
function makeResolver(statuses: Record<string, string> = {}) {
  const calls: string[] = [];
  const resolve = async (assetId: string) => {
    calls.push(assetId);
    const status = statuses[assetId] ?? "READY";
    if (status === "FAILED") return { ok: false as const, reason: "Asset failed to process.", code: "FAILED" as const };
    if (status === "MISSING") return { ok: false as const, reason: "Unknown asset.", code: "UNKNOWN" as const };
    if (status === "PROCESSING") return { ok: true as const, assetId, fileUrl: "", status: "PROCESSING" as const };
    if (status === "THROW") throw new Error("network exploded at cdn.internal");
    return { ok: true as const, assetId, fileUrl: `https://cdn.shopify.com/${assetId.split("/").pop()}.png`, status: "READY" as const };
  };
  return { resolve, calls };
}

async function createFrom(lines: any[], statuses: Record<string, string> = {}, orderId = 555000111) {
  const db = makeFakeDb();
  const resolver = makeResolver(statuses);
  const result = await createProductionJobFromSource(db, {
    shop: "shop1",
    source: { type: "shopify_order", order: order(lines, orderId) },
    actor: "orders_paid_webhook",
    personalizationResolver: resolver.resolve,
  });
  return { db, result, resolver };
}

const personalizationFiles = (db: any) => db.files.filter((f: any) => f.assetSource === PERSONALIZATION_ASSET_SOURCE);
const snapshotOf = (job: any, index = 0) => JSON.parse(job.items[index].priceSnapshot);

/* ------------------------------------------------------------------ *
 * 1. Baseline
 * ------------------------------------------------------------------ */

describe("no personalization keeps existing production behavior", () => {
  it("creates the job with no personalization rows, snapshot key, or event", async () => {
    const { db, result } = await createFrom([bagLine()]);
    expect(result.created).toBe(true);
    expect(personalizationFiles(db)).toHaveLength(0);
    expect(snapshotOf(result.job).personalization).toBeUndefined();
    expect(db.events.some((e: any) => String(e.eventType).includes("personalization"))).toBe(false);
    expect(String(result.job.internalNotes)).not.toContain("personalization");
  });

  it("does not call Shopify at all when no line carries personalization", async () => {
    const db = makeFakeDb();
    const resolver = makeResolver();
    await createProductionJobFromSource(db, {
      shop: "shop1",
      source: { type: "shopify_order", order: order([bagLine()]) },
      personalizationResolver: resolver.resolve,
    });
    expect(resolver.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2-4. Row creation
 * ------------------------------------------------------------------ */

describe("one ProductionJobFile per asset", () => {
  it("creates exactly one row for one READY asset", async () => {
    const { db } = await createFrom([bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] })]);
    const rows = personalizationFiles(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetSource: PERSONALIZATION_ASSET_SOURCE,
      assetRole: PERSONALIZATION_ASSET_ROLE,
      sourceRef: A,
      originalFileName: "logo.png",
      fileUrl: "https://cdn.shopify.com/1111111111.png",
      fileType: "image",
      matchedBy: "shopify_line_property",
    });
  });

  it("creates two rows for a logo + QR, never merged into one", async () => {
    const { db } = await createFrom([
      bagLine({ assets: [
        { assetId: A, originalFileName: "logo.png", status: "READY" },
        { assetId: B, originalFileName: "qr.png", status: "READY" },
      ] }),
    ]);
    const rows = personalizationFiles(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.sourceRef).sort()).toEqual([A, B].sort());
    // distinct rows, distinct urls — nothing concatenated
    expect(new Set(rows.map((r: any) => r.fileUrl)).size).toBe(2);
    expect(rows.every((r: any) => !r.fileUrl.includes(","))).toBe(true);
  });

  it("creates five rows for five assets", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      assetId: `gid://shopify/MediaImage/${i + 1}`,
      originalFileName: `f${i + 1}.png`,
      status: "READY" as const,
    }));
    const { db } = await createFrom([bagLine({ assets: five })]);
    expect(personalizationFiles(db)).toHaveLength(5);
  });

  it("marks a PDF asset as customer_pdf, derived from the Shopify resource type", async () => {
    const { db } = await createFrom([bagLine({ assets: [{ assetId: PDF, originalFileName: "spec.pdf", status: "READY" }] })]);
    expect(personalizationFiles(db)[0].fileType).toBe("customer_pdf");
    expect(snapshotOf((await createFrom([bagLine({ assets: [{ assetId: PDF, originalFileName: "spec.pdf", status: "READY" }] })])).result.job)
      .personalization.assets[0].mimeType).toBe("application/pdf");
  });
});

/* ------------------------------------------------------------------ *
 * 5-9. Resolution
 * ------------------------------------------------------------------ */

describe("assets are re-resolved server-side at production time", () => {
  it("uses Shopify's URL, never anything carried on the order line", async () => {
    const { db, resolver } = await createFrom([
      bagLine({
        assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }],
        // a hostile hand-edited order attribute trying to smuggle a URL
        extraProps: [
          { name: "_GSO Personalization Url", value: "https://evil.example/payload.exe" },
          { name: "_GSO Personalization Assets Url", value: "https://evil.example/x.png" },
        ],
      }),
    ]);
    expect(resolver.calls).toEqual([A]);
    const rows = personalizationFiles(db);
    expect(rows[0].fileUrl).toBe("https://cdn.shopify.com/1111111111.png");
    expect(JSON.stringify(db.files)).not.toContain("evil.example");
    expect(JSON.stringify(db.jobs)).not.toContain("evil.example");
  });

  it("re-resolves an asset stamped PROCESSING at checkout and finds it READY", async () => {
    const { db, result } = await createFrom([
      bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "PROCESSING" }] }),
    ]);
    // the checkout-time stamp is re-derived, not believed
    expect(personalizationFiles(db)[0].fileUrl).toBe("https://cdn.shopify.com/1111111111.png");
    expect(snapshotOf(result.job).personalization.assets[0].status).toBe("READY");
  });

  it("keeps a still-PROCESSING asset without inventing a URL", async () => {
    const { db, result } = await createFrom(
      [bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "PROCESSING" }] })],
      { [A]: "PROCESSING" },
    );
    const row = personalizationFiles(db)[0];
    expect(row.sourceRef).toBe(A);
    expect(row.fileUrl).toBe(`${PERSONALIZATION_PENDING_URL_PREFIX}${A}`);
    // explicitly NOT a fabricated CDN url
    expect(row.fileUrl.startsWith("http")).toBe(false);
    expect(row.fileUrl).not.toContain("cdn.shopify.com");
    expect(row.notes).toContain("ACTION REQUIRED");
    expect(snapshotOf(result.job).personalization.assets[0].fileUrl).toBe("");
    expect(snapshotOf(result.job).personalization.assets[0].status).toBe("PROCESSING");
  });

  it("makes a FAILED asset operator-visible instead of discarding it", async () => {
    const { db, result } = await createFrom(
      [bagLine({ assets: [{ assetId: A, originalFileName: "broken.png", status: "READY" }] })],
      { [A]: "FAILED" },
    );
    // the asset is NOT dropped
    const row = personalizationFiles(db)[0];
    expect(row.sourceRef).toBe(A);
    expect(row.originalFileName).toBe("broken.png");
    expect(row.fileUrl).toBe(`${PERSONALIZATION_FAILED_URL_PREFIX}${A}`);
    expect(row.notes).toContain("ACTION REQUIRED");
    expect(row.notes).toContain("Contact the customer");
    // surfaced on the item, the job, and as an event
    expect(result.job.items[0].productionNotes).toContain("WARNING:");
    expect(result.job.items[0].productionNotes).toContain("FAILED");
    expect(String(result.job.internalNotes)).toContain("ACTION REQUIRED");
    expect(db.events.some((e: any) => e.eventType === "personalization_needs_attention")).toBe(true);
    // and the paid order stays traceable
    expect(result.job.quoteId).toBe("shopify_order_gid://shopify/Order/555000111");
  });

  it("treats a vanished asset as needing intervention, not as success", async () => {
    const { db } = await createFrom(
      [bagLine({ assets: [{ assetId: A, originalFileName: "gone.png", status: "READY" }] })],
      { [A]: "MISSING" },
    );
    expect(personalizationFiles(db)[0].fileUrl.startsWith("http")).toBe(false);
    expect(personalizationFiles(db)[0].notes).toContain("ACTION REQUIRED");
  });

  it("survives a resolver that throws, without losing the asset or the job", async () => {
    const { db, result } = await createFrom(
      [bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] })],
      { [A]: "THROW" },
    );
    expect(result.created).toBe(true);
    expect(personalizationFiles(db)).toHaveLength(1);
    expect(personalizationFiles(db)[0].sourceRef).toBe(A);
    // internal fault detail never reaches stored data
    expect(JSON.stringify(db.files)).not.toContain("cdn.internal");
    expect(JSON.stringify(db.jobs)).not.toContain("cdn.internal");
  });

  it("still creates the job when no resolver is available at all", async () => {
    const db = makeFakeDb();
    const result = await createProductionJobFromSource(db, {
      shop: "shop1",
      source: { type: "shopify_order", order: order([bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] })]) },
      personalizationResolver: null,
    });
    expect(result.created).toBe(true);
    expect(personalizationFiles(db)).toHaveLength(1);
    expect(personalizationFiles(db)[0].fileUrl).toBe(`${PERSONALIZATION_PENDING_URL_PREFIX}${A}`);
  });
});

/* ------------------------------------------------------------------ *
 * 10-12. Filename pairing
 * ------------------------------------------------------------------ */

describe("filename pairing is deterministic", () => {
  it("PROVES Phase 4 emits ids and names in the same order from the same array", () => {
    const built = personalizationLineAttributes([
      { assetId: A, originalFileName: "first.png", status: "READY" },
      { assetId: PDF, originalFileName: "second.pdf", status: "PROCESSING" },
      { assetId: B, originalFileName: "third.png", status: "READY" },
    ]);
    expect(built[1].value).toBe("M1111111111:R,G33:P,M2222222222:R");
    expect(built[2].value).toBe("first.png | second.pdf | third.png");
    // identity is NOT sorted independently of the names
    expect(built[1].value.split(",")).toHaveLength(built[2].value.split(" | ").length);
  });

  it("PROVES a filename can never be empty, so the names list can never shift", () => {
    for (const degenerate of ["", "   ", ".", "..", "///", '<>|?*', " ", null, undefined]) {
      expect(sanitizeOriginalFileName(degenerate as any)).toBeTruthy();
    }
  });

  it("PROVES the pipe separator cannot occur inside a filename", () => {
    expect(sanitizeOriginalFileName("a|b|c.png")).not.toContain("|");
  });

  it("PROVES the 240-char cap is unreachable at max load, so no name is ever truncated away", () => {
    const worst = Array.from({ length: 5 }, (_, i) => ({
      assetId: `gid://shopify/MediaImage/${i + 1}`,
      originalFileName: "z".repeat(200),
      status: "READY" as const,
    }));
    const built = personalizationLineAttributes(worst);
    expect(built[2].value.split(" | ")).toHaveLength(5);
    expect(built[2].value.length).toBe(212);
    expect(built[2].value.length).toBeLessThan(240);
  });

  it("pairs asset N with filename N end to end", async () => {
    const { db } = await createFrom([
      bagLine({ assets: [
        { assetId: A, originalFileName: "alpha.png", status: "READY" },
        { assetId: B, originalFileName: "beta.png", status: "READY" },
      ] }),
    ]);
    const rows = personalizationFiles(db);
    expect(rows.find((r: any) => r.sourceRef === A).originalFileName).toBe("alpha.png");
    expect(rows.find((r: any) => r.sourceRef === B).originalFileName).toBe("beta.png");
  });

  it("REFUSES to pair when the counts disagree — neutral names, never a wrong one", () => {
    // two assets, one name: naive positional pairing would mislabel asset #1
    const decoded = readPersonalizationFromLine(
      (key) => ({
        "_GSO Personalization Assets": "M1111111111:R,M2222222222:R",
        "_GSO Personalization Count": "2",
        "_GSO Personalization Files": "only-one-name.png",
      } as any)[key],
      { isCanonicalStockBagLine: true },
    );
    expect(decoded.assets.map((a) => a.originalFileName)).toEqual(["customer-personalization-1", "customer-personalization-2"]);
    expect(decoded.assets.every((a) => a.originalFileName !== "only-one-name.png")).toBe(true);
    expect(decoded.warnings.some((w) => w.includes("did not line up"))).toBe(true);
  });

  it("falls back to bounded neutral names when the filename attribute is missing", () => {
    const decoded = readPersonalizationFromLine(
      (key) => (key === "_GSO Personalization Assets" ? "M1111111111:R,M2222222222:P" : ""),
      { isCanonicalStockBagLine: true },
    );
    expect(decoded.assets.map((a) => a.originalFileName)).toEqual(["customer-personalization-1", "customer-personalization-2"]);
    expect(personalizationFallbackName(0)).toBe("customer-personalization-1");
  });

  it("pairPersonalizationFileNames never returns a wrong-length list", () => {
    for (const [count, raw] of [[3, "a | b"], [1, "a | b | c"], [2, ""], [0, "a"]] as Array<[number, string]>) {
      expect(pairPersonalizationFileNames(count, raw).names).toHaveLength(count);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 13-16. Malformed / hostile input
 * ------------------------------------------------------------------ */

describe("malformed and hostile attributes are bounded, never trusted", () => {
  const read = (props: Record<string, string>, canonical = true) =>
    readPersonalizationFromLine((key) => props[key] ?? "", { isCanonicalStockBagLine: canonical });

  it("ignores an undecodable identity rather than fabricating an asset", () => {
    const decoded = read({ "_GSO Personalization Assets": "not-an-asset;;;<script>", "_GSO Personalization Count": "2" });
    expect(decoded.assets).toHaveLength(0);
    expect(decoded.warnings.some((w) => w.includes("could not be decoded"))).toBe(true);
  });

  it("drops individually malformed tokens but keeps the valid ones", () => {
    const decoded = read({ "_GSO Personalization Assets": "M11:R,GARBAGE,X9:Z,G22:P" });
    expect(decoded.assets.map((a) => a.assetId)).toEqual(["gid://shopify/MediaImage/11", "gid://shopify/GenericFile/22"]);
  });

  it("bounds more than 5 encoded assets", () => {
    const decoded = read({ "_GSO Personalization Assets": Array.from({ length: 9 }, (_, i) => `M${i + 1}:R`).join(",") });
    expect(decoded.assets).toHaveLength(5);
    expect(decoded.warnings.some((w) => w.includes("only the first 5"))).toBe(true);
  });

  it("deduplicates repeated asset ids", () => {
    const decoded = read({ "_GSO Personalization Assets": "M11:R,M11:R,M11:P,M22:R" });
    expect(decoded.assets.map((a) => a.assetId)).toEqual(["gid://shopify/MediaImage/11", "gid://shopify/MediaImage/22"]);
    expect(decoded.warnings.some((w) => w.includes("duplicate"))).toBe(true);
  });

  it("warns on a count mismatch and trusts the decoded assets", () => {
    const decoded = read({ "_GSO Personalization Assets": "M11:R", "_GSO Personalization Count": "97" });
    expect(decoded.assets).toHaveLength(1);
    expect(decoded.warnings.some((w) => w.includes("count attribute says 97"))).toBe(true);
  });

  it("treats an unknown status letter as undecodable rather than guessing", () => {
    expect(read({ "_GSO Personalization Assets": "M11:Q" }).assets).toHaveLength(0);
  });

  it("REFUSES personalization on a non-canonical line even when the attributes look perfect", () => {
    const decoded = read({ "_GSO Personalization Assets": "M11:R", "_GSO Personalization Files": "logo.png" }, false);
    expect(decoded.assets).toHaveLength(0);
    expect(decoded.warnings[0]).toContain("not a canonical GSO Stock Bag");
  });

  it("refuses customer-forged attributes on a jar line end to end", async () => {
    const jarLine = {
      id: 9100,
      title: "100ml Miron Jar",
      quantity: 50,
      price: "4.50",
      properties: [
        { name: "_GSO Canonical", value: CANONICAL_JAR },
        { name: "Product Family", value: "Jars" },
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "Standard" },
        { name: "Label Set", value: "Standard" },
        ...attrs([{ assetId: A, originalFileName: "smuggled.png", status: "READY" }]),
      ],
    };
    const { db, result, resolver } = await createFrom([jarLine]);
    expect(personalizationFiles(db)).toHaveLength(0);
    expect(resolver.calls).toHaveLength(0);
    expect(snapshotOf(result.job).personalization).toBeUndefined();
    // but the attempt is visible to an operator
    expect(result.job.items[0].productionNotes).toContain("not a canonical GSO Stock Bag");
  });

  it("does not crash the webhook path on hostile personalization data", async () => {
    const hostile = bagLine({
      extraProps: [
        { name: "_GSO Personalization Assets", value: "M".repeat(5000) },
        { name: "_GSO Personalization Count", value: "not-a-number" },
        { name: "_GSO Personalization Files", value: " | | | | | | " },
      ],
    });
    const { db, result } = await createFrom([hostile]);
    expect(result.created).toBe(true);
    expect(db.jobs).toHaveLength(1);
    expect(personalizationFiles(db)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 17-18. Multiple lines
 * ------------------------------------------------------------------ */

describe("assets stay on the correct line", () => {
  it("keeps two Stock Bag lines' files separated and leaves a third line clean", async () => {
    const lines = [
      bagLine({ id: 1, title: "Bag A", assets: [{ assetId: A, originalFileName: "logoA.png", status: "READY" }] }),
      bagLine({ id: 2, title: "Bag B", assets: [
        { assetId: B, originalFileName: "logoB.png", status: "READY" },
        { assetId: PDF, originalFileName: "qrB.pdf", status: "READY" },
      ] }),
      bagLine({ id: 3, title: "Bag C" }),
    ];
    const { db, result } = await createFrom(lines);
    const rows = personalizationFiles(db);
    expect(rows).toHaveLength(3);

    const ticketA = result.job.items[0].itemTicket;
    const ticketB = result.job.items[1].itemTicket;
    const ticketC = result.job.items[2].itemTicket;
    expect(ticketA).not.toBe(ticketB);

    // association is expressed by the itemTicket prefix on fileName…
    expect(rows.filter((r: any) => r.fileName.startsWith(`${ticketA}_`))).toHaveLength(1);
    expect(rows.filter((r: any) => r.fileName.startsWith(`${ticketB}_`))).toHaveLength(2);
    expect(rows.filter((r: any) => r.fileName.startsWith(`${ticketC}_`))).toHaveLength(0);

    // …and machine-readably by snapshot.assetId <-> file.sourceRef
    expect(snapshotOf(result.job, 0).personalization.assets.map((a: any) => a.assetId)).toEqual([A]);
    expect(snapshotOf(result.job, 1).personalization.assets.map((a: any) => a.assetId).sort()).toEqual([B, PDF].sort());
    expect(snapshotOf(result.job, 2).personalization).toBeUndefined();

    // no cross-line mixing
    expect(rows.find((r: any) => r.sourceRef === A).fileName.startsWith(`${ticketA}_`)).toBe(true);
    expect(rows.find((r: any) => r.sourceRef === B).fileName.startsWith(`${ticketB}_`)).toBe(true);
  });

  it("numbers multiple files on the same line 1..N", async () => {
    const { db, result } = await createFrom([
      bagLine({ assets: [
        { assetId: A, originalFileName: "one.png", status: "READY" },
        { assetId: B, originalFileName: "two.png", status: "READY" },
      ] }),
    ]);
    const ticket = result.job.items[0].itemTicket;
    expect(personalizationFiles(db).map((r: any) => r.fileName).sort()).toEqual([
      `${ticket}_PERSONALIZATION-1`,
      `${ticket}_PERSONALIZATION-2`,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 19. Idempotency
 * ------------------------------------------------------------------ */

describe("webhook replay creates no duplicate rows", () => {
  it("delivering the same paid order twice yields one job and one row per asset", async () => {
    const db = makeFakeDb();
    const resolver = makeResolver();
    const lines = [bagLine({ assets: [
      { assetId: A, originalFileName: "logo.png", status: "READY" },
      { assetId: B, originalFileName: "qr.png", status: "READY" },
    ] })];

    const first = await createProductionJobFromSource(db, {
      shop: "shop1", source: { type: "shopify_order", order: order(lines) }, personalizationResolver: resolver.resolve,
    });
    const replay = await createProductionJobFromSource(db, {
      shop: "shop1", source: { type: "shopify_order", order: order(structuredClone(lines)) }, personalizationResolver: resolver.resolve,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(db.jobs).toHaveLength(1);
    expect(personalizationFiles(db)).toHaveLength(2);
    expect(personalizationFiles(db).map((r: any) => r.sourceRef).sort()).toEqual([A, B].sort());
  });

  it("holds under CONCURRENT delivery of the same order", async () => {
    const db = makeFakeDb();
    const resolver = makeResolver();
    const lines = [bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] })];
    await Promise.all([
      createProductionJobFromSource(db, { shop: "shop1", source: { type: "shopify_order", order: order(structuredClone(lines)) }, personalizationResolver: resolver.resolve }),
      createProductionJobFromSource(db, { shop: "shop1", source: { type: "shopify_order", order: order(structuredClone(lines)) }, personalizationResolver: resolver.resolve }),
    ]);
    expect(db.jobs).toHaveLength(1);
    expect(personalizationFiles(db)).toHaveLength(1);
  });

  it("relies on the SAME gate that already deduplicates the Zakeke rows", () => {
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    const branch = source.slice(source.indexOf('if (source.type === "shopify_order")'));
    // both loops sit inside the transaction, after the idempotency early-return
    expect(source.indexOf("const existing = await tx.productionJob.findFirst")).toBeLessThan(source.indexOf("payload.personalizationFiles"));
    expect(branch).toContain("tx.productionJobFile.create");
    // and no migration was added for this
    expect(source.includes("@@unique([shop, jobId, sourceRef])")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 20-21. Zakeke separation
 * ------------------------------------------------------------------ */

describe("Zakeke stays separate", () => {
  const zakekeLine = (assets?: any) => ({
    ...bagLine({ id: 77, title: "Zakeke Bag", assets }),
    properties: [
      ...bagLine({ id: 77, assets }).properties,
      { name: "_GSO Zakeke Design ID", value: "design-abc-123" },
    ],
  });

  it("still creates the Zakeke file row unchanged", async () => {
    const { db } = await createFrom([zakekeLine()]);
    const zakeke = db.files.filter((f: any) => f.assetSource === "zakeke");
    expect(zakeke).toHaveLength(1);
    expect(zakeke[0]).toMatchObject({ assetRole: "artwork", sourceRef: "design-abc-123", fileName: "zakeke-design-design-abc-123" });
  });

  it("lets personalization and Zakeke coexist on different lines without collision", async () => {
    const { db } = await createFrom([
      zakekeLine(),
      bagLine({ id: 78, title: "Plain Bag", assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] }),
    ]);
    const zakeke = db.files.filter((f: any) => f.assetSource === "zakeke");
    const personal = personalizationFiles(db);
    expect(zakeke).toHaveLength(1);
    expect(personal).toHaveLength(1);
    // the two contracts never share a source, role, or sourceRef
    expect(zakeke[0].assetSource).not.toBe(personal[0].assetSource);
    expect(zakeke[0].assetRole).not.toBe(personal[0].assetRole);
    expect(personal[0].assetRole).toBe("personalization");
    expect(personal[0].assetSource).toBe("customer_upload");
    expect(zakeke[0].sourceRef).not.toBe(personal[0].sourceRef);
  });

  it("keeps both snapshots nested and independent on one line", async () => {
    const { result } = await createFrom([zakekeLine([{ assetId: A, originalFileName: "logo.png", status: "READY" as const }])]);
    const snapshot = snapshotOf(result.job);
    expect(snapshot.zakeke.designId).toBe("design-abc-123");
    expect(snapshot.personalization.count).toBe(1);
    expect(snapshot.personalization.assets[0].assetId).toBe(A);
  });
});

/* ------------------------------------------------------------------ *
 * 22-23. Snapshot shape / thumbnail safety
 * ------------------------------------------------------------------ */

describe("snapshot nesting protects the product thumbnail", () => {
  it("nests personalization and puts no loose image field at the top level", async () => {
    const { result } = await createFrom([
      bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] }),
    ]);
    const snapshot = snapshotOf(result.job);
    expect(snapshot.personalization.count).toBe(1);
    expect(snapshot.personalization.assets[0]).toEqual({
      assetId: A,
      originalFileName: "logo.png",
      fileUrl: "https://cdn.shopify.com/1111111111.png",
      mimeType: "image/*",
      status: "READY",
    });
    // the loose readers (firstImageFromQuoteItem / snapshotValue) look ONLY here
    expect(snapshot.productImageUrl).toBeUndefined();
    expect(snapshot.imageUrl).toBeUndefined();
    expect(snapshot.fileUrl).toBeUndefined();
  });

  it("never lets customer artwork become the job or item product image", async () => {
    const { db, result } = await createFrom([
      bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] }),
    ]);
    expect(result.job.productImageUrl ?? "").not.toContain("cdn.shopify.com/1111111111.png");
    expect(result.job.items[0].productImageUrl ?? "").not.toContain("1111111111");
    // and the ERP's role->job-field promotion does not recognise this role
    const ui = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    const promote = ui.slice(ui.indexOf("function jobAssetUpdateForRole"), ui.indexOf("function roleFromFileType"));
    expect(promote).not.toContain("personalization");
    expect(personalizationFiles(db)[0].assetRole).toBe("personalization");
  });
});

/* ------------------------------------------------------------------ *
 * 24-25. Commercial invariants
 * ------------------------------------------------------------------ */

describe("personalization changes nothing commercial", () => {
  it("produces an identical priced job with and without personalization", async () => {
    // same order id on purpose — each call gets its own fake database, so the
    // two jobs are directly comparable field for field
    const withFiles = await createFrom([bagLine({ assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] })], {}, 900001);
    const without = await createFrom([bagLine()], {}, 900001);

    const a = withFiles.result.job.items[0];
    const b = without.result.job.items[0];
    expect(a.unitPrice).toBe(b.unitPrice);
    expect(a.unitCost).toBe(b.unitCost);
    expect(a.quantity).toBe(b.quantity);
    expect(a.selectedFinish).toBe(b.selectedFinish);
    expect(a.materialSummary).toBe(b.materialSummary);
    expect(a.selectedAddOns).toBe(b.selectedAddOns);

    // and every commercial field of the snapshot is untouched
    const sa = JSON.parse(a.priceSnapshot);
    const sb = JSON.parse(b.priceSnapshot);
    delete sa.personalization;
    expect(sa).toEqual(sb);
  });

  it("keeps MOQ 50 and touches no pricing module", async () => {
    const { result } = await createFrom([bagLine({ assets: [{ assetId: A, originalFileName: "l.png", status: "READY" }] })]);
    expect(result.job.items[0].quantity).toBe(50);
    expect(snapshotOf(result.job).canonical.qty).toBe(50);
    const lib = readFileSync("app/lib/personalization-production.server.ts", "utf8");
    for (const token of ["unitPrice", "unitCost", "priceEach", "margin", "quantity"]) {
      expect(lib.includes(token)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 26-30. Scope guards
 * ------------------------------------------------------------------ */

describe("Phase 5 changed nothing outside the backend data path", () => {
  it("added no Prisma migration and no schema field", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const fileModel = schema.slice(schema.indexOf("model ProductionJobFile"));
    expect(fileModel.slice(0, fileModel.indexOf("}")).includes("personalization")).toBe(false);
    expect(schema.includes("model PersonalizationProductionAsset")).toBe(false);
    // ProductionJobFile.fileUrl is still the original NON-NULLABLE String —
    // Phase 5 works within that constraint rather than relaxing it
    expect(/^\s*fileUrl\s+String\s*$/m.test(fileModel.replace(/\r/g, ""))).toBe(true);
  });

  it("leaves the feature gate OFF and the storefront untouched", () => {
    const block = readFileSync("extensions/wholesale-theme/blocks/gso-product-configurator.liquid", "utf8");
    const setting = block.slice(block.indexOf('"id": "enable_personalization"'));
    expect(setting.slice(0, setting.indexOf("}"))).toContain('"default": false');
    expect(block).toContain("block.settings.enable_personalization and product.type == 'Stock Bag'");
    // No Phase 5 code in any theme asset. Assert on USE, not on words that
    // appear in comments explaining what the browser deliberately never does.
    for (const asset of ["gso-personalization.js", "gso-product-configurator.js", "gso-zakeke-bridge.js"]) {
      const source = readFileSync(`extensions/wholesale-theme/assets/${asset}`, "utf8");
      expect(/\bdb\.|prisma|productionJobFile|assetSource\s*[:=]|createProductionJob/.test(source)).toBe(false);
    }
  });

  it("leaves the fake legacy uploader disabled", () => {
    const template = readFileSync("shopify-theme/templates/product.configurator-pilot.json", "utf8");
    const parsed = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
    expect(parsed.sections["1771828352671bead8"].blocks.ai_gen_block_15f470a_xiVLGg.disabled).toBe(true);
  });

  it("keeps the webhook resilient and never leaks the admin token", () => {
    const webhook = readFileSync("app/routes/webhooks.orders_paid.tsx", "utf8");
    // resolver construction is fail-soft
    expect(webhook).toContain("catch (error)");
    expect(webhook).toContain("return null;");
    // shop comes from the verified webhook, and the token stays in the closure
    expect(webhook).toContain("unauthenticated.admin(shop)");
    expect(webhook).not.toContain("db.session.findFirst");
    expect(/console\.(log|error)\([^)]*accessToken/.test(webhook)).toBe(false);
    // the quote-payment branch is untouched
    expect(webhook).toContain("applyQuotePaymentFromOrder");
  });

  it("never runs a Shopify call inside the Prisma transaction", () => {
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    const resolveAt = source.indexOf("await resolveOrderPersonalization(");
    const txAt = source.indexOf("dbClient.$transaction(async (tx: any) =>");
    expect(resolveAt).toBeGreaterThan(0);
    expect(resolveAt).toBeLessThan(txAt);
  });

  it("keeps buildShopifyOrderJobPayload backward compatible for existing callers", () => {
    const payload: any = buildShopifyOrderJobPayload(order([bagLine()]), "GSO-20260813-0001");
    expect(payload.items).toHaveLength(1);
    expect(payload.personalizationFiles).toEqual([]);
    expect(JSON.parse(payload.items[0].priceSnapshot).personalization).toBeUndefined();
  });

  it("decodes personalization off exactly the configurator lines, in order", () => {
    const decoded = decodeOrderPersonalization(
      order([
        { id: 1, title: "Not a configurator line", quantity: 1, properties: [] },
        bagLine({ id: 2, assets: [{ assetId: A, originalFileName: "logo.png", status: "READY" }] }),
      ]),
    );
    // the non-configurator line is filtered out before indexing, so index 0 is the bag
    expect(decoded).toHaveLength(1);
    expect(decoded[0].index).toBe(0);
    expect(decoded[0].assets[0].assetId).toBe(A);
  });
});
