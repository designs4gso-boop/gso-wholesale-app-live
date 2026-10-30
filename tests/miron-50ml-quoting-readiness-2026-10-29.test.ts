// 2026-10-29 — URGENT 50ML MIRON QUOTING READINESS.
//
// Owner authority: the 50ml Miron BLANK jar + lid ladder is 1-249 $2.47,
// 250-499 $2.26, 500-999 $2.06, 1,000-2,499 $1.93, 2,500+ $1.77 (cost only;
// labels, media, ink, printing, application, setup and freight stay separate
// lines). The real calculator loader runs against an in-memory DB double that
// carries the stale live VendorProduct row, to prove the row never sets the cost.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

const CLEAR = {
  id: "m_clear", shop: "shop-1", name: "Clear Material", materialType: "roll_media", productFamilies: "labels",
  unit: "sqft", baseUnit: "sqft", purchaseUnit: "roll", costPerUnit: 0.3227, calculatedUnitCost: 0.3227, purchaseCost: 0,
  rollWidthIn: 54, rollLengthFt: 150, costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor", primaryVendorId: null,
};
const MATTE = { ...CLEAR, id: "m_matte", name: "Poseidon Matte", costPerUnit: 0.2, calculatedUnitCost: 0.2 };
const dbState: { materials: any[]; writes: string[] } = { materials: [], writes: [] };

vi.mock("../app/db.server", async () => {
  const { CANONICAL_CALIBRATION_IDENTITIES } = await import("../app/lib/machine-routing.server");
  const MEASURED: Record<string, any> = {
    "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
    "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
    "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
    "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
  };
  const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]: any) => ({
    id: `cal_${key}`, shop: "shop-1", ...identity, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null,
    timeModel: "variable_only", measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved",
    source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date(0), ...MEASURED[key],
  }));
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (/^(create|update|upsert|delete)/.test(method)) { dbState.writes.push(`${name}.${method}`); return {}; }
      const where = args?.where || {};
      if (name === "machineProfileCalibration" && method === "findMany") {
        return ROWS.filter((row: any) => Object.entries(where).every(([f, v]) => (f === "shop" ? true : row[f] === v)));
      }
      if (name === "material" && method === "findMany") {
        return dbState.materials.filter((m) => (!where.shop || m.shop === where.shop) && (!where.id?.in || where.id.in.includes(m.id)));
      }
      if (name === "vendorProduct" && method === "findMany") return (globalThis as any).VENDOR_ROWS || [];
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any[]) => Promise.all(ops) : model(key)) });
  return { default: db, db };
});

import db from "../app/db.server";
import { OWNER_USER_IDS_ENV, type OwnerAuthorization } from "../app/lib/owner-authorization.server";
import {
  CALCULATOR_READY,
  NEEDS_COST_SETUP,
  attachVerifiedLabelMaterials,
  materialCalculatorReadiness,
} from "../app/lib/material-calculator-readiness.server";
import { APPROVED_ROLL_COSTS, APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";
import { LABEL_MATERIALS, computeLabelJob } from "../app/lib/label-cost-inputs.server";
import { canonicalLabelMaterialKey } from "../app/lib/canonical-calculator-shared";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  resolveCanonicalMachineInputs,
  type ResolvedMachineInputs,
} from "../app/lib/canonical-calculator.server";
import {
  CHIRON_SET_COST,
  MIRON_SET_COST,
  MIRON_SET_COST_PROVENANCE,
  MIRON_TIER_MIN_QTYS,
  STANDARD_SET_COST,
  resolveJarBlankCost,
} from "../app/lib/jar-cost-inputs.server";
import { ACTIVE_JAR_PROFILES, resolveActiveJarProfile } from "../app/lib/jar-active-scope";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { PROVISIONAL_PRICING_STATUS } from "../app/lib/calculator-owner-view";
import { ownerSetQuoteItemPrice } from "../app/lib/quote-owner-price-approval.server";

const ROUTE = "app/routes/app.erp.cost-calculator.tsx";
const src = (path: string) => readFileSync(path, "utf8");
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  process.env[OWNER_USER_IDS_ENV] = "9001";
  authState.sub = "9001";
  dbState.materials = [{ ...CLEAR }, { ...MATTE }];
  dbState.writes = [];
});
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; });

/** The exact GET a single-line sticker job submits (legacy fields + canonical pl0* mirror). */
const stickerQs = (pl0mat: string, extra = "", pmat = "m_clear") =>
  `pfamily=stickers-labels&pqty=500&pwidth=3&pheight=3&pmat=${pmat}&pcut=square-rect&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0` +
  `&pllines=1&pl0qty=500&pl0w=3&pl0h=3&pl0mat=${encodeURIComponent(pl0mat)}&pl0cuttype=rectangular&pl0art=ART-1&pl0printsetups=1${extra}`;

/** Server path: normalise -> attach verified materials -> resolve machine -> assemble. */
async function costLabelJob(qs: string) {
  const raw = normalizeCanonicalInput(new URLSearchParams(qs))!;
  const input = await attachVerifiedLabelMaterials({ db, shop: "shop-1" }, raw);
  const machine = await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input);
  return { input, machine, result: assembleCanonicalJob(input, machine) };
}

async function loaderData(qs: string) {
  const route = await import("../app/routes/app.erp.cost-calculator");
  return { route, data: await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) } as any) as any };
}
function render(route: any, data: any, qs: string) {
  const Stub = createRoutesStub([{ id: "calc", path: "/app/erp/cost-calculator", Component: route.default, loader: () => data }]);
  return textOf(renderToString(createElement(AppProvider as any, { i18n: en },
    createElement(Stub as any, { initialEntries: [`/app/erp/cost-calculator?${qs}`], hydrationData: { loaderData: { calc: data } } }))));
}


/* ================================================================== *
 * 2026-10-29 — 50ML MIRON QUOTING READINESS
 * ================================================================== */
import { JAR_PLANNED_OVERAGE_PCT, productionQtyFor } from "../app/lib/jar-cost-inputs.server";
import { JAR_BASE_PRICES } from "../app/lib/canonical-jar-pricing";

const LADDER_2026_10_29 = [2.47, 2.26, 2.06, 1.93, 1.77];

// The live VendorProduct row as seeded 2026-07-17 — production still holds the stale $2.46 ladder.
const STALE_ROW = {
  id: "vp_50", shop: "shop-1", name: "50ml Miron jar + lid", productType: "jar", vendor: "MIRON", vendorSku: "preset:miron-50ml", active: true,
  defaultUnitCost: 2.46, moq: 128, addOns: [],
  tiers: [[1, 249, 2.46], [250, 499, 2.24], [500, 999, 2.03], [1000, 2499, 1.89], [2500, null, 1.74]].map(([minQty, maxQty, unitCost]) => ({ minQty, maxQty, unitCost })),
};

/** Exactly what the calculator form submits for a 50ml Miron job with side + lid + tamper labels. */
const jarQs = (qty: number) => [
  "pfamily=premium-jars", `pqty=${qty}`, "pblank=vendor:vp_50", "plid=type:standard-top", "pjar=miron/50ml", "pjarvariant=",
  "pjarset=side_lid", "pjartamperopt=1", "pjarside=1", "pjarlid=1", "pjartamper=1",
  "plabelcount=3", "psame=no", "plabeltype=side", "plabelw=5.6", "plabelh=1.5", "plabeltype=lid", "plabelw=1.6", "plabelh=1.6", "plabeltype=tamper", "plabelw=5.6", "plabelh=0.5",
  "pdesigns=1", "pmat=m_matte", "pprinter=auto", "pcut=square-rect", "pwhitelayers=0", "pglosslayers=0", "pcmykcoverage=40",
].join("&");

async function jarJob(qty: number) {
  (globalThis as any).VENDOR_ROWS = [STALE_ROW];
  try {
    const { route, data } = await loaderData(jarQs(qty));
    const pm = data.emergency.productMode;
    const line = (key: string) => pm.canonical.lines.find((l: any) => l.key === key);
    return { route, data, pm, line, requested: pm.tiers.find((tier: any) => tier.requested) };
  } finally {
    delete (globalThis as any).VENDOR_ROWS;
  }
}

describe("Q1. the 2026-10-29 owner ladder is the one canonical 50ml blank jar + lid cost", () => {
  it("every source-controlled 50ml authority carries $2.47 / $2.26 / $2.06 / $1.93 / $1.77", () => {
    expect(MIRON_SET_COST["50ml"]).toEqual(LADDER_2026_10_29);
    expect(MIRON_SET_COST_PROVENANCE["50ml"]).toEqual({ status: "OWNER_VERIFIED", record: "Owner-approved 50ml Miron blank jar + lid acquisition cost ladder, 2026-10-29" });
    const registry = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")! as any;
    expect(registry.tiers).toEqual([
      { minQty: 1, maxQty: 249, unitCost: 2.47 }, { minQty: 250, maxQty: 499, unitCost: 2.26 },
      { minQty: 500, maxQty: 999, unitCost: 2.06 }, { minQty: 1000, maxQty: 2499, unitCost: 1.93 },
      { minQty: 2500, maxQty: null, unitCost: 1.77 },
    ]);
    expect(registry.marker).toBe("[VERIFIED 2026-10-29 owner-approved 50ml Miron blank jar + lid cost ladder]");
    expect(src("tools/seed-jar-finish-pricing-rules.mjs")).toContain("jar_50ml: [2.47, 2.26, 2.06, 1.93, 1.77],");
    expect(src("tools/seed-jar-erp-foundation.mjs")).toContain("defaultUnitCost: 2.47, // owner-approved 2026-10-29 (blank jar + lid)");
  });

  it("boundaries step at 1 / 250 / 500 / 1,000 / 2,500 and never interpolate", () => {
    const expected: Array<[number, number]> = [
      [1, 2.47], [249, 2.47], [250, 2.26], [499, 2.26], [500, 2.06], [999, 2.06],
      [1000, 1.93], [2499, 1.93], [2500, 1.77], [10000, 1.77],
      [374, 2.26], [1750, 1.93], // mid-band: the band price, not a blend
    ];
    for (const [quantity, unitCost] of expected) {
      const r = resolveJarBlankCost({ brand: "miron", size: "50ml", quantity });
      expect(r.ok && r.unitCost, String(quantity)).toBe(unitCost);
    }
  });

  it("the tier is chosen on PRODUCTION quantity (ordered + 1% overage); these ordered quantities cross a band", () => {
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(1);
    const cases: Array<[number, number, number]> = [
      // ordered, produced, unit cost
      [246, 249, 2.47], [247, 250, 2.26],
      [494, 499, 2.26], [495, 500, 2.06],
      [989, 999, 2.06], [990, 1000, 1.93],
      [2474, 2499, 1.93], [2475, 2500, 1.77],
    ];
    for (const [ordered, produced, unitCost] of cases) {
      expect(productionQtyFor(ordered), String(ordered)).toBe(produced);
      const r = resolveJarBlankCost({ brand: "miron", size: "50ml", quantity: productionQtyFor(ordered) });
      expect(r.ok && r.unitCost, String(ordered)).toBe(unitCost);
    }
  });

  it("no other jar authority moved", () => {
    expect(MIRON_SET_COST).toEqual({
      "50ml": LADDER_2026_10_29,
      "100ml_tall": [2.78, 2.54, 2.31, 2.14, 1.99],
      "100ml_wide": [2.9, 2.67, 2.44, 2.26, 2.1],
      "150ml": [3.26, 3.0, 2.76, 2.54, 2.37],
      "250ml": [3.92, 3.6, 3.32, 3.11, 2.92],
    });
    expect(CHIRON_SET_COST).toEqual({ "100ml_tall": 1.8, "100ml_wide": 1.8, "150ml": 1.9 });
    expect(STANDARD_SET_COST).toEqual({ "3oz": { clear: 0.5, black_white: 0.62 }, "4oz": { clear: 0.6, black_white: 0.65 } });
  });
});

describe("Q2. a real 50ml quote through the calculator loader (side + lid + tamper labels, stale live row present)", () => {
  it("500 jars: READY TO QUOTE, blank jar + lid at the table rate, every other cost on its own line", async () => {
    const { pm, line, requested } = await jarJob(500);
    expect(pm.canonical.blockers).toEqual([]);
    expect(requested.status).toBe("READY TO QUOTE");
    expect(requested.costAuthority).toBe("canonical");
    // blank = 505 produced sets x $2.06 — the stale $2.46/$2.03 row is never read
    expect(line("blank_sets").formula).toBe("505 x $2.0600");
    expect(line("blank_sets").amount).toBeCloseTo(505 * 2.06, 9);
    // labels, media, ink, machine, setup and application are separate lines, never inside the blank
    for (const key of ["print_media", "ink", "art_setup", "print_setup", "run_labor", "application", "cutting_machine", "cutting_attention", "weeding", "machine", "packout", "inbound_freight"]) {
      expect(line(key)?.amount, key).toBeGreaterThan(0);
    }
    expect(line("application").note).toContain("side 12s + lid 10s + tamper/lid-side 12s = 34s per jar");
    expect(pm.canonical.diagnostics.applicationsPerItem).toBe(3);
    expect(pm.canonical.diagnostics.productSpec.standard).toEqual({ side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } });
    const sum = pm.canonical.lines.reduce((total: number, l: any) => total + l.amount, 0);
    expect(pm.canonical.totalCost).toBeCloseTo(sum, 6);
  }, 120_000);

  it("249 / 250 / 500 / 1,000 / 2,500 jars cost at the production-quantity tier and are all quotable", async () => {
    const expected: Array<[number, string]> = [[249, "252 x $2.2600"], [250, "253 x $2.2600"], [500, "505 x $2.0600"], [1000, "1010 x $1.9300"], [2500, "2525 x $1.7700"]];
    for (const [qty, formula] of expected) {
      const { line, requested } = await jarJob(qty);
      expect(line("blank_sets").formula, String(qty)).toBe(formula);
      expect(requested.status, String(qty)).toBe("READY TO QUOTE");
      expect(requested.unitPrice, String(qty)).toBeGreaterThan(0);
    }
  }, 300_000);

  it("selling price: the 16D owner ladder is unchanged and still the price authority, with the existing 45% margin protection", async () => {
    expect(JAR_BASE_PRICES["50ml"]).toEqual([
      { minQty: 50, priceEach: 4.25 }, { minQty: 100, priceEach: 4.0 }, { minQty: 250, priceEach: 3.75 },
      { minQty: 500, priceEach: 3.5 }, { minQty: 1000, priceEach: 3.25 }, { minQty: 2500, priceEach: 3.0 },
    ]);
    const { pm, requested } = await jarJob(500);
    expect(pm.pricingBasis.kind).toBe("owner_ladder");
    expect(requested.commercial.ownerLadder.label).toBe("Owner jar price ladder (16D, owner-approved 2026-08-12): 50ml @ 500+ = $3.50");
    // the ladder price is below the existing 45% minimum margin, so the existing floor raises the price
    expect(requested.commercial.ownerLadder.raisedByFloor).toBe(true);
    expect(requested.totalPrice).toBeCloseTo(requested.jobCost / (1 - 0.45), 6);
    expect(requested.actualMarginPct).toBeCloseTo(45, 6);
  }, 120_000);

  it("the jar picker shows the owner-approved ladder, never the stale live row price", async () => {
    const { route, data, pm } = await jarJob(500);
    const option = pm.blankOptions.find((o: any) => o.value === "vendor:vp_50");
    expect(option.jarProfile).toBe("miron/50ml");
    expect(option.label).toBe("50ml Miron jar + lid — standard top included in vendor set — tiered $2.47 → $1.77 (owner-approved jar cost) — Verified");
    (globalThis as any).VENDOR_ROWS = [STALE_ROW];
    try {
      const page = render(route, data, jarQs(500));
      expect(page).toContain("tiered $2.47 → $1.77 (owner-approved jar cost)");
      expect(page).not.toContain("$2.46 — Verified");
      expect(page).toContain("READY TO QUOTE");
      expect(page).not.toContain("Application Error");
    } finally {
      delete (globalThis as any).VENDOR_ROWS;
    }
  }, 120_000);
});
