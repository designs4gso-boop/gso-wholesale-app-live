// 2026-11-11 — CUSTOMER-BLOCKING JOB: 1 x 1 in Clear Material sticker, 5,000,
// one white layer at 90% coverage, customer asked for the Mimaki.
//
// Production (main) refused it with "does not map to a verified canonical
// roll (matte, gloss or holographic)". That gate was replaced on this release
// branch by the structured Material Center resolver
// (material-calculator-readiness.server.ts). These tests pin the exact job
// through the REAL server path — normalise -> attach verified materials ->
// routing -> assemble -> loader tier rows -> save action — so it cannot regress.
//
// Owner routing authority (machine-routing.server.ts, unchanged):
//   white requires the Roland; explicit Mimaki + white BLOCKS (never priced on
//   the Mimaki, white never silently removed); AUTO routes to the Roland.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

// The production Clear Material record as the owner described it: $0.3227/sqft verified.
const CLEAR = {
  id: "m_clear", shop: "shop-1", name: "Clear Material", materialType: "roll_media", productFamilies: "labels",
  unit: "sqft", baseUnit: "sqft", purchaseUnit: "roll", costPerUnit: 0.3227, calculatedUnitCost: 0.3227, purchaseCost: 0,
  rollWidthIn: 54, rollLengthFt: 150, costReviewNeeded: false, useInRecipes: true, active: true, vendor: "Media Vendor", primaryVendorId: null,
};
const dbState: { materials: any[]; writes: string[]; creates: any[] } = { materials: [], writes: [], creates: [] };

vi.mock("../app/db.server", async () => {
  const { CANONICAL_CALIBRATION_IDENTITIES } = await import("../app/lib/machine-routing.server");
  // Byte-identical to tools/seed-machine-profile-calibrations.mjs (owner-measured).
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
      if (/^(create|update|upsert|delete)/.test(method)) { dbState.writes.push(`${name}.${method}`); if (name === "quote" && method === "create") dbState.creates.push(args); return { id: `${name}_new` }; }
      const where = args?.where || {};
      if (name === "machineProfileCalibration" && method === "findMany") {
        return ROWS.filter((row: any) => Object.entries(where).every(([f, v]) => (f === "shop" ? true : row[f] === v)));
      }
      if (name === "material" && method === "findMany") {
        return dbState.materials.filter((m) => (!where.shop || m.shop === where.shop) && (!where.id?.in || where.id.in.includes(m.id)));
      }
      if (name === "material" && method === "findFirst") {
        return dbState.materials.find((m) => m.shop === where.shop && m.id === where.id) ?? null;
      }
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any) => (typeof ops === "function" ? ops(db) : Promise.all(ops)) : model(key)) });
  return { default: db, db };
});

import db from "../app/db.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { attachVerifiedLabelMaterials, materialCalculatorReadiness } from "../app/lib/material-calculator-readiness.server";
import { assembleCanonicalJob, normalizeCanonicalInput, resolveCanonicalMachineInputs } from "../app/lib/canonical-calculator.server";
import { ROUTING_REASONS } from "../app/lib/machine-routing.server";

beforeEach(() => {
  process.env[OWNER_USER_IDS_ENV] = "9001";
  authState.sub = "9001";
  dbState.materials = [{ ...CLEAR }];
  dbState.writes = [];
  dbState.creates = [];
});
afterEach(() => { delete process.env[OWNER_USER_IDS_ENV]; });

/** Raquel's job exactly as the calculator form submits it (legacy p* fields + canonical pl0* mirror). */
const raquelQs = ({ printer = "auto", white = "1", coverage = "90" as string | null } = {}) =>
  `pfamily=stickers-labels&pqty=5000&pwidth=1&pheight=1&pmat=m_clear&pcut=square-rect&pdesigns=1&pprinter=${printer}` +
  `&pwhitelayers=${white}${coverage == null ? "" : `&pwhitecoverage=${coverage}`}&pglosslayers=0` +
  `&pllines=1&pl0qty=5000&pl0w=1&pl0h=1&pl0mat=${encodeURIComponent("material:m_clear")}&pl0cuttype=rectangular&pl0art=ART-1&pl0printsetups=1`;

async function costJob(qs: string) {
  const raw = normalizeCanonicalInput(new URLSearchParams(qs))!;
  const input = await attachVerifiedLabelMaterials({ db, shop: "shop-1" }, raw);
  const machine = await resolveCanonicalMachineInputs({ db, shop: "shop-1" }, input);
  return { input, result: assembleCanonicalJob(input, machine) };
}

async function loaderData(qs: string) {
  const route = await import("../app/routes/app.erp.cost-calculator");
  return { route, data: await route.loader({ request: new Request(`https://app.test/app/erp/cost-calculator?${qs}`) } as any) as any };
}

describe("Clear Material 1x1 x 5,000 with 90% white — the live customer job", () => {
  it("Clear Material is calculator-ready from its own stored Material Center rate", () => {
    expect(materialCalculatorReadiness(CLEAR)).toMatchObject({ ready: true, canonicalKey: "material:m_clear", source: "material_center", costPerSqft: 0.3227, missing: [] });
  });

  it("the canonical cutline is 0.875 x 0.875 in, derived from the 1 x 1 artboard", async () => {
    const { input } = await costJob(raquelQs());
    expect(input.labels!.lines[0]).toMatchObject({ printWidthIn: 1, printHeightIn: 1, cutWidthIn: 0.875, cutHeightIn: 0.875, quantity: 5000 });
  }, 120_000);

  it("customer-selected MIMAKI + white blocks with the routing reason — never priced on the Mimaki, white never removed", async () => {
    const { result } = await costJob(raquelQs({ printer: "mimaki" }));
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.routing.whiteLayers).toBe(1);
    expect(result.routing.effectivePrinter).toBe("roland");
    expect(result.blockers.join(" ")).toContain(ROUTING_REASONS.mimakiSpecialtyUnsupported);
    expect(result.blockers.join(" ")).toContain("Route this job to the Roland");
    // the material is NOT the problem any more
    expect(result.blockers.join(" ")).not.toContain("LABEL_MATERIAL_COST_REQUIRED");
  }, 120_000);

  for (const printer of ["auto", "roland"]) {
    it(`printer=${printer} prices on the Roland with Clear Material at $0.3227/sqft and a 90% white channel`, async () => {
      const { result } = await costJob(raquelQs({ printer }));
      expect(result.blockers).toEqual([]);
      expect(result.status).not.toBe("DRAFT_ONLY");
      expect(result.unitCost).toBeGreaterThan(0);
      expect(result.routing.effectivePrinter).toBe("roland");
      expect(result.adapter.label!.lines[0].material).toEqual({ label: "Clear Material", costPerSqft: 0.3227 });
      const white = result.inkChannels.find((c: any) => c.kind === "white")!;
      expect(white).toMatchObject({ coveragePct: 90, passes: 1, mlPerSqftPerPass: 6.0, calibrationResolved: true });
      expect(white.totalMl!).toBeCloseTo(white.inkableSqft! * 0.9 * 6.0, 9);
      const keys = result.trueCost.lines.map((l: any) => l.key);
      for (const key of ["print_media", "ink", "ink_white", "machine", "machine_white", "cutting_machine", "weeding"]) expect(keys, key).toContain(key);
    }, 120_000);
  }

  it("white coverage scales WHITE INK only; press occupancy is the full layout per layer", async () => {
    const at90 = (await costJob(raquelQs({ coverage: "90" }))).result;
    const at100 = (await costJob(raquelQs({ coverage: "100" }))).result;
    const amount = (r: any, key: string) => r.trueCost.lines.find((l: any) => l.key === key)?.amount;
    expect(amount(at90, "ink_white")).toBeCloseTo(amount(at100, "ink_white") * 0.9, 9);
    expect(amount(at90, "machine_white")).toBeCloseTo(amount(at100, "machine_white"), 9);
  }, 120_000);

  it("missing white coverage blocks (no default) — never quietly priced", async () => {
    const { result } = await costJob(raquelQs({ coverage: null }));
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join(" ")).toContain(ROUTING_REASONS.whiteCoverageRequired);
  }, 120_000);

  it("the real calculator loader shows the 5,000 row READY TO QUOTE on AUTO, and BLOCKED (not $0) on Mimaki", async () => {
    const auto = (await loaderData(raquelQs())).data;
    const autoRow = auto.emergency.productMode.tiers.find((t: any) => t.quantity === 5000);
    expect(autoRow.status, JSON.stringify(autoRow.blockers)).toBe("READY TO QUOTE");
    expect(autoRow.unitCost).toBeGreaterThan(0);
    expect(autoRow.costAuthority).toBe("canonical");

    const mimaki = (await loaderData(raquelQs({ printer: "mimaki" }))).data;
    const mimakiRow = mimaki.emergency.productMode.tiers.find((t: any) => t.quantity === 5000);
    expect(mimakiRow.status).toBe("BLOCKED");
    expect(mimakiRow.unitCost).toBeNull();
    expect(mimakiRow.jobCost).toBeNull();
  }, 120_000);

  it("save recomputes server-side: AUTO saves a canonical cost; Mimaki + white refuses and writes nothing", async () => {
    const route = await import("../app/routes/app.erp.cost-calculator");
    const save = async (qs: string) => {
      const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${qs}`, pseltier: "5000", eproduct: "Clear 1x1 white", ecustomer: "Test Customer" });
      for (const [k, v] of new URLSearchParams(qs)) body.set(k, v);
      const response = await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) } as any);
      return response instanceof Response ? { status: response.status, headers: response.headers, json: await response.clone().json().catch(() => null) } : { status: 0, headers: null, json: response };
    };
    const blocked = await save(raquelQs({ printer: "mimaki" }));
    expect(blocked.json?.ok).toBe(false);
    expect(dbState.writes).toEqual([]);

    const ok = await save(raquelQs());
    // A successful save either redirects to the new quote or returns ok:true — and it wrote a quote.
    expect(ok.json?.ok === true || (ok.status >= 300 && ok.status < 400), JSON.stringify(ok.json)).toBe(true);
    expect(dbState.writes.some((w) => w.startsWith("quote."))).toBe(true);
  }, 120_000);

  it("the saved snapshot records the press and the 90% white coverage used", async () => {
    const route = await import("../app/routes/app.erp.cost-calculator");
    const body = new URLSearchParams({ intent: "saveEmergencyQuoteDraft", psearch: `?${raquelQs()}`, pseltier: "5000", ecustomer: "Test" });
    await route.action({ request: new Request("https://app.test/app/erp/cost-calculator", { method: "POST", body }) } as any);
    const snapshot = JSON.parse(dbState.creates[0].data.items.create[0].costSnapshot).canonical;
    expect(snapshot.routing).toMatchObject({ effectivePrinter: "roland", whiteLayers: 1 });
    expect(snapshot.inkChannels.find((c: any) => c.kind === "white")).toMatchObject({ coveragePct: 90, passes: 1 });
  }, 120_000);
});
