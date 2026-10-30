// 2026-10-28 — COST CALCULATOR MATERIAL INTEGRATION FIX + 50ML MIRON COST AUTHORITY.
//
// MATERIAL: a Material Center record becomes a canonical Stickers & Labels
// material from its STRUCTURED fields (print media, active, Labels family,
// stored $/sqft not under review, vendor, roll width) — never its exact name.
// The server re-reads it by id; matte / gloss / holographic keep their
// approved roll rates unchanged; anything incomplete stays blocked in plain
// English, and no calculator error takes the admin down.
//
// 50ML MIRON: the owner-approved jar + top acquisition-cost ladder replaces the
// 2026-07-17 50ml values in the existing Miron architecture. It is COST only;
// the existing 16D sell ladder stays the price authority.
//
// The real calculator loader / action run against an in-memory DB double.

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
 * MATERIAL SYSTEM
 * ================================================================== */
describe("1-3. Material Center records become calculator materials from structured fields", () => {
  it("1. a properly configured Clear Material is calculator-selectable with a canonical key", async () => {
    const readiness = materialCalculatorReadiness(CLEAR);
    expect(readiness).toMatchObject({ applies: true, ready: true, label: CALCULATOR_READY, canonicalKey: "material:m_clear", source: "material_center", missing: [] });
    const { data } = await loaderData("pfamily=stickers-labels");
    const option = data.emergency.productMode.materialOptions.find((o: any) => o.value === "m_clear");
    expect(option.canonicalKey).toBe("material:m_clear");
    expect(option.label).toBe("Clear Material — 0.3227/sqft — Calculator ready");
  }, 120_000);

  it("2. the STORED Material Center cost is the cost authority (re-read by id on the server)", async () => {
    const { input, result } = await costLabelJob(stickerQs("material:m_clear"));
    expect(input.labels!.materials!["material:m_clear"]).toEqual({
      key: "material:m_clear", label: "Clear Material", costPerSqft: 0.3227, rollWidthIn: 54, source: "material_center", materialId: "m_clear",
    });
    const line = result.adapter.label!.lines[0];
    expect(line.material).toEqual({ label: "Clear Material", costPerSqft: 0.3227 });
    expect(line.materialCost).toBeCloseTo(line.nesting!.materialFootprintSqft * 0.3227, 10);
    expect(result.blockers.join(" ")).not.toContain("LABEL_MATERIAL_COST_REQUIRED");
    expect(result.status).not.toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeGreaterThan(0);
    // ink, machine, labor and cutting stay their own lines
    const keys = result.trueCost.lines.map((l: any) => l.key);
    for (const key of ["print_media", "ink", "machine", "run_labor", "cutting_machine"]) expect(keys, key).toContain(key);
  }, 120_000);

  it("3. no exact-name hardcoding: any compatible name works; the rate is not in code", async () => {
    const renamed = { ...CLEAR, id: "m_new", name: "Zeta Window Film 9000" };
    dbState.materials.push(renamed);
    expect(materialCalculatorReadiness(renamed).canonicalKey).toBe("material:m_new");
    const { result } = await costLabelJob(stickerQs("material:m_new", "", "m_new"));
    expect(result.adapter.label!.lines[0].material).toEqual({ label: "Zeta Window Film 9000", costPerSqft: 0.3227 });
    for (const file of ["app/lib/material-calculator-readiness.server.ts", "app/lib/label-cost-inputs.server.ts", "app/lib/canonical-calculator.server.ts", "app/lib/canonical-calculator-shared.ts", ROUTE]) {
      expect(src(file), file).not.toMatch(/Clear Material|0\.3227/);
    }
  }, 120_000);
});

describe("4-6, 11. printer routing is unchanged for a Material Center material", () => {
  it("CMYK-only defaults to the Mimaki; explicit Roland CMYK is allowed", async () => {
    const auto = (await costLabelJob(stickerQs("material:m_clear"))).result;
    expect(auto.routing.effectivePrinter).toBe("mimaki");
    expect(auto.routing.whiteLayers).toBe(0); // clear substrate alone never invents white
    const roland = (await costLabelJob(stickerQs("material:m_clear").replace("pprinter=auto", "pprinter=roland"))).result;
    expect(roland.routing.effectivePrinter).toBe("roland");
  }, 120_000);

  it("Clear + white and Clear + gloss route to the Roland; Mimaki is blocked for white/gloss", async () => {
    const white = (await costLabelJob(stickerQs("material:m_clear").replace("pwhitelayers=0", "pwhitelayers=1&pwhitecoverage=60"))).result;
    expect(white.routing.effectivePrinter).toBe("roland");
    expect(white.routing.whiteLayers).toBe(1);
    const gloss = (await costLabelJob(stickerQs("material:m_clear").replace("pglosslayers=0", "pglosslayers=1&pglosscoverage=40"))).result;
    expect(gloss.routing.effectivePrinter).toBe("roland");
    const mimakiWhite = (await costLabelJob(stickerQs("material:m_clear").replace("pprinter=auto", "pprinter=mimaki").replace("pwhitelayers=0", "pwhitelayers=1&pwhitecoverage=60"))).result;
    expect(mimakiWhite.status).toBe("DRAFT_ONLY");
    expect(mimakiWhite.blockers.length).toBeGreaterThan(0);
    // routing is identical to the same job on matte (material never changes the press)
    const matteWhite = (await costLabelJob(stickerQs("matte", "", "m_matte").replace("pwhitelayers=0", "pwhitelayers=1&pwhitecoverage=60"))).result;
    expect(white.routing).toEqual(matteWhite.routing);
  }, 120_000);
});

describe("7-9. incomplete / unsupported materials stay blocked, safely", () => {
  it("7. each missing piece blocks with a plain-English reason", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ rollWidthIn: null }, "Roll width is missing."],
      [{ productFamilies: "sticker_bags" }, "Not assigned to the Labels product family."],
      [{ costPerUnit: 0, calculatedUnitCost: 0 }, "No stored cost per sqft."],
      [{ costReviewNeeded: true }, "Cost is marked \"needs review\" — confirm it first."],
      [{ vendor: null, primaryVendorId: null }, "No vendor set."],
      [{ active: false }, "Material is inactive."],
      [{ unit: "each", baseUnit: "roll", materialType: "roll_media" }, "Cost is not per sqft (or per sq in)."],
    ];
    for (const [patch, reason] of cases) {
      const readiness = materialCalculatorReadiness({ ...CLEAR, ...patch });
      expect(readiness.ready, reason).toBe(false);
      expect(readiness.label).toBe(NEEDS_COST_SETUP);
      expect(readiness.canonicalKey).toBeNull();
      expect(readiness.missing, reason).toContain(reason);
    }
    // blanks / inks are not calculator print media at all
    expect(materialCalculatorReadiness({ ...CLEAR, materialType: "blank_bags", unit: "each", baseUnit: "each" }).applies).toBe(false);
  });

  it("7/9. a forged key for an unready or another shop's material still blocks — and never costs $0", async () => {
    dbState.materials = [{ ...CLEAR, rollWidthIn: null }, { ...CLEAR, id: "m_other", shop: "shop-2" }];
    for (const key of ["material:m_clear", "material:m_other", "material:missing", ""]) {
      const { input, result } = await costLabelJob(stickerQs(key));
      expect(input.labels!.materials?.[key]).toBeUndefined();
      expect(result.status, key).toBe("DRAFT_ONLY");
      expect(result.unitCost, key).toBeNull();
      expect(result.blockers.join(" "), key).toContain("LABEL_MATERIAL_COST_REQUIRED");
    }
  }, 120_000);

  it("8. an unsupported material renders a blocked result and a plain reason — the page does not crash", async () => {
    dbState.materials = [{ ...CLEAR, rollWidthIn: null }];
    const qs = stickerQs("");
    const { route, data } = await loaderData(qs);
    expect(data.emergency.productMode.materialOptions[0].calculatorMissing).toEqual(["Roll width is missing."]);
    const text = render(route, data, qs);
    expect(text).toContain("COST & PRICING RESULT PRICING BLOCKED");
    expect(text).toContain("TRUE JOB COST Not available");
    expect(text).toContain("Needs cost setup — this material is not calculator-ready yet.");
    expect(text).toContain("Roll width is missing.");
    expect(text).not.toContain("does not map to a verified canonical roll");
    // the save refuses in plain words, writes nothing, throws nothing
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${qs}`, pseltier: "500", eproduct: "Clear test" });
    const saved = await (await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) } as any) as Response).json();
    expect(saved.ok).toBe(false);
    expect(saved.message).toContain("CANONICAL_TRUE_COST_REQUIRED");
    expect(dbState.writes).toEqual([]);
  }, 120_000);

  it("6/8 (crash path). an unexpected calculator error renders PRICING BLOCKED instead of the app-wide Application Error", async () => {
    const route = await import("../app/routes/app.erp.cost-calculator");
    // The router hands a loader/action/render error to the route ErrorBoundary.
    const Stub = createRoutesStub([{ id: "calc", path: "/app/erp/cost-calculator", Component: route.default, ErrorBoundary: route.ErrorBoundary }]);
    const original = console.error;
    console.error = () => {};
    let html = "";
    try {
      html = renderToString(createElement(Stub as any, {
        initialEntries: ["/app/erp/cost-calculator"],
        hydrationData: { errors: { calc: new Error("boom: material resolver") } },
      }));
    } finally {
      console.error = original;
    }
    const text = textOf(html);
    expect(text).toContain("PRICING BLOCKED");
    expect(text).toContain("Technical detail: boom: material resolver");
    expect(text).not.toContain("Application Error");
    expect(src(ROUTE)).toContain("if (isRouteErrorResponse(error)) return boundary.error(error);");
  }, 120_000);
});

describe("6, 10-12. existing behaviour and history", () => {
  it("6/12. a changed stored cost changes FUTURE jobs; a saved snapshot keeps the rate it was costed at", async () => {
    const before = await costLabelJob(stickerQs("material:m_clear"));
    const snapshot = JSON.parse(JSON.stringify(before.input)); // what a saved quote carries
    dbState.materials = [{ ...CLEAR, costPerUnit: 0.4, calculatedUnitCost: 0.4 }];
    const after = await costLabelJob(stickerQs("material:m_clear"));
    expect(after.result.adapter.label!.lines[0].material!.costPerSqft).toBe(0.4);
    expect(after.result.totalCost).toBeGreaterThan(before.result.totalCost);
    const replayed = assembleCanonicalJob(snapshot, before.machine);
    expect(replayed.adapter.label!.lines[0].material!.costPerSqft).toBe(0.3227);
    expect(replayed.totalCost).toBeCloseTo(before.result.totalCost, 10);
  }, 120_000);

  it("7-10. matte / gloss / holographic keep their approved roll rates, unchanged", async () => {
    expect(LABEL_MATERIALS.matte.costPerSqft).toBe(APPROVED_ROLL_COSTS.poseidonMattePerSqft);
    expect(LABEL_MATERIALS.gloss.costPerSqft).toBe(APPROVED_ROLL_COSTS.poseidonGlossPerSqft);
    expect(LABEL_MATERIALS.holographic.costPerSqft).toBe(APPROVED_ROLL_COSTS.holographicPerSqft);
    for (const [name, key] of [["Poseidon Matte", "matte"], ["Poseidon Gloss", "gloss"], ["Holographic Roll", "holographic"]] as const) {
      const readiness = materialCalculatorReadiness({ ...CLEAR, name, costPerUnit: 9.99, calculatedUnitCost: 9.99, rollWidthIn: null, vendor: null });
      expect(readiness).toMatchObject({ ready: true, canonicalKey: key, source: "approved_roll_rate", costPerSqft: LABEL_MATERIALS[key].costPerSqft });
    }
    // a verified-material map never changes an approved-key line
    const line = { key: "l", quantity: 500, printWidthIn: 3, printHeightIn: 3, cutWidthIn: 2.875, cutHeightIn: 2.875, materialKey: "matte" };
    const plain = computeLabelJob({ lines: [line] });
    const withMap = computeLabelJob({ lines: [line], materials: { "material:m_clear": { key: "material:m_clear", label: "x", costPerSqft: 99, rollWidthIn: 54, source: "material_center", materialId: "m_clear" } } });
    expect(withMap).toEqual(plain);
    // the matte job through the whole server path matches the approved rate
    const matte = (await costLabelJob(stickerQs("matte", "", "m_matte"))).result;
    expect(matte.adapter.label!.lines[0].material).toEqual({ label: "Poseidon Matte", costPerSqft: APPROVED_ROLL_COSTS.poseidonMattePerSqft });
    // glow has no canonical support today: it would go through the Material Center path
    expect(canonicalLabelMaterialKey("Glow Vinyl")).toBeNull();
  }, 120_000);
});

/* ================================================================== *
 * 50ML MIRON
 * ================================================================== */
describe("12-22. 50ml Miron jar + top acquisition cost", () => {
  it("12. 50ml Miron is recognized in the active scope, with owner provenance", () => {
    expect(resolveActiveJarProfile("50ml Miron jar + lid")?.key).toBe("miron/50ml");
    expect(ACTIVE_JAR_PROFILES.some((p) => p.key === "miron/50ml" && p.uiFamily === "premium-jars")).toBe(true);
    expect(MIRON_SET_COST_PROVENANCE["50ml"]?.status).toBe("OWNER_VERIFIED");
  });

  it("13-20. boundaries step, never interpolate", () => {
    const at = (quantity: number) => resolveJarBlankCost({ brand: "miron", size: "50ml", quantity });
    const expected: Array<[number, number]> = [
      [1, 2.47], [249, 2.47], [250, 2.26], [499, 2.26], [500, 2.06], [999, 2.06],
      [1000, 1.93], [2499, 1.93], [2500, 1.77], [100000, 1.77], [374, 2.26],
    ];
    for (const [quantity, unitCost] of expected) {
      const r = at(quantity);
      expect(r.ok, String(quantity)).toBe(true);
      expect(r.ok && r.unitCost, String(quantity)).toBe(unitCost);
    }
    expect(MIRON_TIER_MIN_QTYS).toEqual([1, 250, 500, 1000, 2500]);
    // the cost-verification registry carries the same bands
    const fifty = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")!;
    expect(fifty.tiers).toEqual([
      { minQty: 1, maxQty: 249, unitCost: 2.47 }, { minQty: 250, maxQty: 499, unitCost: 2.26 },
      { minQty: 500, maxQty: 999, unitCost: 2.06 }, { minQty: 1000, maxQty: 2499, unitCost: 1.93 },
      { minQty: 2500, maxQty: null, unitCost: 1.77 },
    ]);
  });

  it("21. jar + top stays one blank line; labels, application, print, ink and machine stay separate", () => {
    const CAL: ResolvedMachineInputs = {
      calibration: {
        id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
        mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: 0, timeModel: "variable_only",
        coverageBasisPct: 100, measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null,
      } as any,
      calibrationMessage: "approved", inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl, inkCostSource: "canonical purchasing rate",
    };
    const input = normalizeCanonicalInput(new URLSearchParams("pfamily=premium-jars&pqty=200&pjar=miron/50ml&pjarside=1&pjarlid=1&pcmykcoverage=40"))!;
    const r = assembleCanonicalJob({ ...input, equipmentRatePerHour: 8 }, CAL);
    const amount = (key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount;
    expect(amount("blank_sets")).toBeCloseTo(202 * 2.47, 9); // 200 + 1% overage = 202 sets at the 1+ tier
    for (const key of ["print_media", "ink", "application", "art_setup", "machine"]) expect(amount(key), key).toBeGreaterThan(0);
    // the frozen fixture moved ONLY on blank_sets
    const fixture = JSON.parse(src("tests/fixtures/jar-fixtures-2026-10-05.json"))["miron/50ml/side_lid"];
    expect(r.trueCost.lines.map((l: any) => [l.key, l.amount])).toEqual(fixture.lines);
  });

  it("22. every other Miron, Chiron and standard jar authority is unchanged", () => {
    expect(MIRON_SET_COST).toEqual({
      "50ml": [2.47, 2.26, 2.06, 1.93, 1.77],
      "100ml_tall": [2.78, 2.54, 2.31, 2.14, 1.99],
      "100ml_wide": [2.9, 2.67, 2.44, 2.26, 2.1],
      "150ml": [3.26, 3.0, 2.76, 2.54, 2.37],
      "250ml": [3.92, 3.6, 3.32, 3.11, 2.92],
    });
    expect(CHIRON_SET_COST).toEqual({ "100ml_tall": 1.8, "100ml_wide": 1.8, "150ml": 1.9 });
    expect(STANDARD_SET_COST).toEqual({ "3oz": { clear: 0.5, black_white: 0.62 }, "4oz": { clear: 0.6, black_white: 0.65 } });
    const tiers = (key: string) => APPROVED_COST_TRUTH.find((item) => item.key === key)!.tiers!.map((t) => t.unitCost);
    expect(tiers("miron-100ml-tall")).toEqual([2.78, 2.54, 2.31, 2.14, 1.99]);
    expect(tiers("miron-100ml-wide")).toEqual([2.9, 2.67, 2.44, 2.26, 2.1]);
    expect(tiers("miron-150ml")).toEqual([3.26, 3.0, 2.76, 2.54, 2.37]);
    expect(tiers("miron-250ml")).toEqual([3.92, 3.6, 3.32, 3.11, 2.92]);
  });
});

describe("23-25. selling price safety", () => {
  it("23. no selling price is invented: the existing 16D sell ladder stays the only 50ml price authority", () => {
    const sell = (quantity: number) => {
      const r = resolveJarOwnerLadder({ brand: "miron", sizeKey: "50ml", quantity });
      return r.ok ? r.quote.unitPrice : null;
    };
    expect([50, 100, 250, 500, 1000, 2500].map(sell)).toEqual([4.25, 4, 3.75, 3.5, 3.25, 3]);
    // no 50ml sell price equals a 50ml cost rung — the cost ladder never became a price
    const sellPrices = [50, 100, 250, 500, 1000, 2500].map(sell);
    for (const cost of MIRON_SET_COST["50ml"]!) expect(sellPrices).not.toContain(cost);
    // the calculator's price authority for a jar is still the owner ladder (16D), never the cost table
    expect(src("app/lib/jar-commercial-pricing.ts")).not.toContain("MIRON_SET_COST");
  });

  it("24. outside the approved ladder, 50ml has no price authority (provisional, never a margin-curve price)", () => {
    for (const quantity of [10, 5000]) {
      const r = resolveJarOwnerLadder({ brand: "miron", sizeKey: "50ml", quantity });
      expect(r.ok, String(quantity)).toBe(false);
    }
    expect(PROVISIONAL_PRICING_STATUS).toBe("PROVISIONAL — PRICING AUTHORITY REQUIRED");
  });

  it("25. the owner approval flow still sets and approves a provisional 50ml price", async () => {
    const item: any = {
      id: "item_1", quoteId: "q_1", productName: "50ml Miron Jar", variant: null, sku: null, quantity: 5000, unitPrice: 0, unitCost: 2.1,
      notes: null, recipeId: null, marginPct: null, selectedAddOnIds: "",
      costSnapshot: JSON.stringify({ canonical: { family: "premium-jars", input: { quantity: 5000 } } }),
      priceSnapshot: JSON.stringify({ pricingAuthority: { approved: false, status: PROVISIONAL_PRICING_STATUS, kind: "none", source: null, missing: "Volume quote", customerUnitPrice: null, customerTotalPrice: null } }),
    };
    const state: any = { quote: { id: "q_1", shop: "shop-1", status: "draft", notes: "", customerTier: "standard", items: [item] } };
    const fake: any = {
      quote: { findFirst: async () => state.quote, updateMany: async (a: any) => { Object.assign(state.quote, a.data); return { count: 1 }; } },
      quoteItem: { updateMany: async (a: any) => { Object.assign(item, a.data); return { count: 1 }; } },
      $transaction: async (ops: any[]) => Promise.all(ops),
    };
    const owner: OwnerAuthorization = { isOwner: true, userId: "9001", actor: "owner@gso.test", reason: "Configured owner" };
    const result = await ownerSetQuoteItemPrice(fake, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "3.10", reason: "Volume order", owner });
    expect(result.ok).toBe(true);
    expect(JSON.parse(item.priceSnapshot).pricingAuthority.approved).toBe(true);
    const staff: OwnerAuthorization = { isOwner: false, userId: "1234", actor: "staff@gso.test", reason: "Owner-only action." };
    expect((await ownerSetQuoteItemPrice(fake, { shop: "shop-1", quoteId: "q_1", itemId: "item_1", unitPrice: "1", reason: "x", owner: staff })).ok).toBe(false);
  });
});

/* ================================================================== *
 * SECURITY / ACCESS
 * ================================================================== */
describe("26-28. Cost & Pricing stays owner-only, server-side", () => {
  it("26/28. a non-owner gets 403 from the calculator loader and action before any material is read", async () => {
    authState.sub = "1234";
    const route = await import("../app/routes/app.erp.cost-calculator");
    for (const call of [
      () => route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${stickerQs("material:m_clear")}`) } as any),
      () => route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body: new URLSearchParams({ intent: "saveEmergencyQuoteDraft" }) }) } as any),
    ]) {
      const thrown = await call().then(() => null, (error: any) => error);
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
    }
  }, 120_000);

  it("27. Material Center readiness carries no cost, margin or rate — only a label and reasons", () => {
    const materials = src("app/routes/app.erp.materials.tsx");
    expect(materials).toContain("calculatorReadiness: readiness.applies ? { label: readiness.label, source: readiness.source, missing: readiness.missing } : null");
    const blocked = materialCalculatorReadiness({ ...CLEAR, rollWidthIn: null });
    expect(JSON.stringify({ label: blocked.label, missing: blocked.missing })).not.toMatch(/\d\.\d{2}/);
  });
});

/* ================================================================== *
 * FINAL CONSISTENCY PATCH (2026-10-28)
 * ================================================================== */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JAR_PLANNED_OVERAGE_PCT, productionQtyFor } from "../app/lib/jar-cost-inputs.server";
import { approvedRollKeyOf } from "../app/lib/material-calculator-readiness.server";

const NEW_50ML = [2.47, 2.26, 2.06, 1.93, 1.77];
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "node_modules") return [];
  return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx|mjs|js|json)$/.test(name) ? [path] : [];
});

describe("C1-C2. one current 50ml Miron cost ladder in source control", () => {
  it("1. every source-controlled 50ml cost authority uses the owner-approved ladder", () => {
    expect(MIRON_SET_COST["50ml"]).toEqual(NEW_50ML);
    const registry = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")! as any;
    expect(registry.tiers.map((t: any) => t.unitCost)).toEqual(NEW_50ML);
    expect(registry.marker).toBe("[VERIFIED 2026-10-29 owner-approved 50ml Miron blank jar + lid cost ladder]");
    expect(registry.tierNote).toBe("Owner-approved 2026-10-29");
    const foundation = src("tools/seed-jar-erp-foundation.mjs");
    const block = foundation.slice(foundation.indexOf('key: "jar_50ml"'), foundation.indexOf('key: "jar_100ml_tall"'));
    expect(block).toContain("defaultUnitCost: 2.47,");
    for (const [minQty, unitCost] of [[1, "2.47"], [250, "2.26"], [500, "2.06"], [1000, "1.93"], [2500, "1.77"]] as const) {
      expect(block).toMatch(new RegExp(`minQty: ${minQty}, maxQty: [0-9a-z]+, unitCost: ${unitCost.replace(".", "\\.")},`));
    }
    expect(src("tools/seed-jar-finish-pricing-rules.mjs")).toContain("jar_50ml: [2.47, 2.26, 2.06, 1.93, 1.77],");
  });

  it("2. no old 50ml ladder remains as a current authority anywhere in app/ or tools/", () => {
    const stale = [/\[\s*2\.46,\s*2\.24,\s*2\.03,\s*1\.89,\s*1\.74\s*\]/, /\[\s*2\.31,\s*2\.08,\s*1\.88,\s*1\.75,\s*1\.60?\s*\]/, /defaultUnitCost:\s*2\.31\b/, /Owner-approved 2026-10-28 [<0-9]/, /unitCost:\s*2\.46\b/, /unitCost:\s*2\.24\b/, /unitCost:\s*2\.03\b/, /unitCost:\s*1\.89\b/, /unitCost:\s*1\.74\b/, /defaultUnitCost:\s*2\.46\b/];
    for (const file of [...filesUnder("app"), ...filesUnder("tools")]) {
      const text = readFileSync(file, "utf8");
      for (const pattern of stale) expect(pattern.test(text), `${file} ${pattern}`).toBe(false);
    }
  }, 120_000);
});

describe("C3-C4. Miron cost tier = PRODUCTION quantity (owner decision, intentional)", () => {
  it("3. 248 ordered -> 251 produced (1% overage) -> the 250-499 tier, $2.26", () => {
    expect(productionQtyFor(248)).toBe(251);
    const tier = resolveJarBlankCost({ brand: "miron", size: "50ml", quantity: productionQtyFor(248) });
    expect(tier.ok && tier.unitCost).toBe(2.26);
    const input = normalizeCanonicalInput(new URLSearchParams("pfamily=premium-jars&pqty=248&pjar=miron/50ml&pjarside=1&pjarlid=1&pcmykcoverage=40"))!;
    const CAL: ResolvedMachineInputs = {
      calibration: {
        id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk", ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
        mlPerSqftPerPass: 1.6, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout", fixedMinutes: 0, timeModel: "variable_only",
        coverageBasisPct: 100, measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null,
      } as any,
      calibrationMessage: "approved", inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl, inkCostSource: "canonical purchasing rate",
    };
    const r = assembleCanonicalJob(input, CAL);
    expect(r.trueCost.lines.find((l: any) => l.key === "blank_sets")!.amount).toBeCloseTo(251 * 2.26, 9);
  });

  it("4. the production-overage math itself is unchanged", () => {
    expect(JAR_PLANNED_OVERAGE_PCT).toBe(1);
    expect([0, 1, 200, 248, 249, 1000].map((q) => productionQtyFor(q))).toEqual([0, 2, 202, 251, 252, 1010]);
    expect(src("app/lib/jar-cost-inputs.server.ts")).toContain("return Math.ceil(finished * (1 + overagePct / 100));");
  });
});

describe("C5-C12. a structured record's own stored cost wins; names never redirect it", () => {
  it("5-7. Clear Gloss / Clear Matte / other finish words use their OWN stored cost, not Poseidon's", async () => {
    const own = [
      { ...CLEAR, id: "m_cg", name: "Clear Gloss", costPerUnit: 0.41, calculatedUnitCost: 0.41 },
      { ...CLEAR, id: "m_cm", name: "Clear Matte", costPerUnit: 0.37, calculatedUnitCost: 0.37 },
      { ...CLEAR, id: "m_glow", name: "Glow Matte Film", costPerUnit: 0.9, calculatedUnitCost: 0.9 },
      { ...CLEAR, id: "m_holo2", name: "Holographic Silver Film", costPerUnit: 0.66, calculatedUnitCost: 0.66 },
      { ...CLEAR, id: "m_gm", name: "Gloss Matte Clear Overlay", costPerUnit: 0.29, calculatedUnitCost: 0.29 },
    ];
    dbState.materials.push(...own);
    for (const record of own) {
      expect(approvedRollKeyOf(record), record.name).toBeNull();
      expect(materialCalculatorReadiness(record), record.name).toMatchObject({ canonicalKey: `material:${record.id}`, source: "material_center", costPerSqft: record.calculatedUnitCost });
      const { result } = await costLabelJob(stickerQs(`material:${record.id}`, "", record.id));
      expect(result.adapter.label!.lines[0].material, record.name).toEqual({ label: record.name, costPerSqft: record.calculatedUnitCost });
    }
    // an incomplete "Clear Gloss" is blocked — never quietly priced as Poseidon Gloss
    const incomplete = materialCalculatorReadiness({ ...CLEAR, id: "m_cg2", name: "Clear Gloss", rollWidthIn: null });
    expect(incomplete).toMatchObject({ ready: false, canonicalKey: null, missing: ["Roll width is missing."] });
    // the readiness rule no longer uses the substring name mapper
    expect(src("app/lib/material-calculator-readiness.server.ts")).not.toContain("canonicalLabelMaterialKey(");
  }, 120_000);

  it("8-10. the approved Poseidon Matte / Poseidon Gloss / Holographic records keep their approved rate", () => {
    const cases: Array<[Record<string, unknown>, "matte" | "gloss" | "holographic"]> = [
      [{ name: "Poseidon Matte" }, "matte"],
      [{ name: "Poseidon Matte Roll Media", costPerUnit: 0.2889, calculatedUnitCost: 0.2889 }, "matte"], // a stale stored cost never overrides the approved rate
      [{ name: "Poseidon Gloss Roll Media" }, "gloss"],
      [{ name: "Holographic Roll Media" }, "holographic"],
      [{ name: "Holographic" }, "holographic"],
      [{ name: "Holographic Gloss Vinyl" }, "holographic"],
      [{ name: "Holo Rainbow Holographic 50in", notes: "[VERIFIED 2026-07-17 owner-approved roll/ink cost]" }, "holographic"], // registry-stamped record
    ];
    for (const [patch, key] of cases) {
      const readiness = materialCalculatorReadiness({ ...CLEAR, ...patch });
      expect(readiness, String(patch.name)).toMatchObject({ ready: true, canonicalKey: key, source: "approved_roll_rate", costPerSqft: LABEL_MATERIALS[key].costPerSqft });
    }
    expect(LABEL_MATERIALS.matte.costPerSqft).toBe(APPROVED_ROLL_COSTS.poseidonMattePerSqft);
    expect(LABEL_MATERIALS.gloss.costPerSqft).toBe(APPROVED_ROLL_COSTS.poseidonGlossPerSqft);
    expect(LABEL_MATERIALS.holographic.costPerSqft).toBe(APPROVED_ROLL_COSTS.holographicPerSqft);
  });

  it("11. Clear Material still resolves from Material Center", () => {
    expect(materialCalculatorReadiness(CLEAR)).toMatchObject({ canonicalKey: "material:m_clear", source: "material_center", costPerSqft: 0.3227 });
  });
});

describe("C16. pricing formulas unchanged by this work", () => {
  it("no selling-price module was touched", () => {
    for (const file of [
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/canonical-jar-pricing.ts", "app/lib/jar-commercial-pricing.ts", "app/lib/customer-tiers.ts",
      "app/lib/storefront-canonical-pricing.server.ts", "app/lib/canonical-bag-pricing.server.ts", "app/lib/calculator-owner-view.ts",
    ]) expect(src(file), file).not.toContain("2026-10-28");
  });
});
