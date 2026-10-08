// MACHINE RECOVERY RATE IMPACT — OWNER DECISION 2026-10-07 ($8/hr provisional -> $5/hr approved).
//
// Computes the canonical control jobs with the CURRENT owner machine recovery
// rate and writes docs/generated/machine-recovery-impact-<rate>.json. Run once
// before the rate change (captures the $8 baseline) and once after ($5); the
// two files are diffed into docs/generated/machine-recovery-impact-2026-10-07.md.
// With GSO_IMPACT_CAPTURE unset it also pins the approved $5 results.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeCanonicalJob, normalizeCanonicalInput } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { canonicalStockBagJob } from "../app/lib/canonical-bag-pricing.server";
import { computeProductDrivenCost, type ProductDrivenInput } from "../app/lib/product-driven-costing.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { MACHINE_RATE_CURRENT } from "../app/lib/rip-actual-costs-shared";
import { machineRatePerHour } from "../app/lib/rip-actual-costs.server";
import { lookupSpektraVendorCost } from "../app/lib/spektra-live-cost-book";
import { resolveDtpQuoteCost } from "../app/lib/dtp-quote-cost-authority.server";

const CAPTURE = process.env.GSO_IMPACT_CAPTURE === "1";
const RATE = OWNER_STANDARDS.machineRecoveryPerHour.value;

/* Production-shaped calibration rows (same as the 2D-4C1 control suite). */
const MEASURED: Record<string, { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const SHOP = "942075-2.myshopify.com";
const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`, shop: SHOP, ...identity,
  inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null, timeModel: "variable_only",
  measuredAt: new Date("2026-08-18T00:00:00Z"), effectiveFrom: new Date("2026-08-18T00:00:00Z"), effectiveTo: null,
  status: "approved", source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date("2026-08-18T00:00:00Z"),
  ...MEASURED[key],
}));
const db = { machineProfileCalibration: { findMany: async ({ where }: any) => ROWS.filter((row) => Object.entries(where).every(([field, value]) => field === "shop" ? row.shop === value : (row as any)[field] === value)) } };
const canon = (q: string) => computeCanonicalJob({ db, shop: SHOP }, normalizeCanonicalInput(new URLSearchParams(q))!);

const CONTROLS = {
  "3x3 sticker control (1,000 matte, AUTO CMYK)": "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=0",
  "4x5 Sticker Bag (100, 1 face, 40% coverage)": "pfamily=sticker-bags&pqty=100&pbagsides=1&pcmykcoverage=40",
  "Roland CMYK job (1,000 x 3x3 matte, explicit Roland)": "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=roland&pwhitelayers=0&pglosslayers=0",
  "Roland WHITE job (1,000 x 3x3, 1 white layer, 100% coverage)": "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=1&pwhitecoverage=100&pglosslayers=0",
  "Roland GLOSS job (1,000 x 3x3, 1 gloss layer)": "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=1",
  "Miron jar control (100ml Tall, 128, Side + Lid, AUTO CMYK)": "pfamily=premium-jars&pqty=128&pjar=miron/100ml_tall&pjarside=1&pjarlid=1&pjarset=side_lid&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0",
} as const;

const POSEIDON_PER_SQFT = 0.3155555555555555;
const BANNER_PER_SQFT = 0.2962962962962963;
function bannerInput(): ProductDrivenInput {
  return {
    family: "banners", quantity: 1, designs: 1, facesPerUnit: 1, widthIn: 36, heightIn: 72, labelRows: null, dtp: null, blank: null, lid: null, mironTop: null,
    material: { name: "Banner Vinyl", costPerSqft: BANNER_PER_SQFT }, printer: "mimaki", printerHasWhite: true, printerHasGloss: false,
    whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6, machineMinutesPerSqft: 0, machineSqftPerHour: 0, machineRatePerHour: RATE,
    cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null, wasteOverride: null, boxOverride: null,
  } as ProductDrivenInput;
}
const STOCK_BAG_INPUTS: any = {
  available: true, reasons: [],
  blank: { name: "Stock Bag 4x5 (representative)", unitCost: 0.25, tiers: [] },
  matte: { name: "Poseidon Matte Roll Media", costPerSqft: POSEIDON_PER_SQFT },
  holographic: null,
  rolandSqftPerHour: 150,
};

type Snapshot = { rate: number; controls: Record<string, { total: number; unit: number | null; status: string; lines: Record<string, number> }> };

async function snapshot(): Promise<Snapshot> {
  const controls: Snapshot["controls"] = {};
  for (const [label, q] of Object.entries(CONTROLS)) {
    const r = await canon(q);
    const lines: Record<string, number> = {};
    for (const l of r.trueCost.lines) lines[l.key] = (lines[l.key] || 0) + l.amount;
    controls[label] = { total: r.totalCost ?? 0, unit: r.unitCost ?? null, status: r.status, lines };
  }
  const bag = canonicalStockBagJob(STOCK_BAG_INPUTS, { quantity: 100, faces: 1 }) as any;
  if (bag.available) {
    const lines: Record<string, number> = {};
    for (const l of bag.run?.lines || bag.lines || []) lines[l.key] = (lines[l.key] || 0) + l.amount;
    controls["Stock Bag (100, 1 face, matte, representative $0.25 blank)"] = { total: bag.run?.totalCost ?? bag.totalCost ?? bag.jobCost, unit: bag.run?.unitCost ?? bag.unitCost ?? null, status: "product-driven", lines };
  } else {
    controls["Stock Bag (100, 1 face, matte, representative $0.25 blank)"] = { total: 0, unit: null, status: "unavailable: " + (bag.reasons || []).join("; "), lines: {} };
  }
  const banner = computeProductDrivenCost(bannerInput());
  const bl: Record<string, number> = {};
  for (const l of banner.lines) bl[l.key] = (bl[l.key] || 0) + l.amount;
  controls["Banner control (one 3x6 ft, plain)"] = { total: banner.totalCost, unit: banner.unitCost, status: "product-driven", lines: bl };
  // DTP must be unaffected by machine recovery
  const dtp = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-4x5x2", quantity: 1000, designs: 1, selection: { material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false }, legacy: { totalCost: 0, missing: true, vendorSubtotal: null } });
  controls["DTP 4x5x2 x 1,000 (outsourced — must not move)"] = { total: dtp.landedCost, unit: dtp.landedCost / 1000, status: dtp.status, lines: { vendor: dtp.vendorSubtotal ?? 0, art: dtp.artCost, freight: dtp.freight } };
  return { rate: RATE, controls };
}

describe("machine recovery rate impact snapshot", () => {
  it(`captures every control at the current owner machine recovery rate ($${RATE}/hr)`, async () => {
    const snap = await snapshot();
    mkdirSync(new URL("../docs/generated/", import.meta.url), { recursive: true });
    writeFileSync(new URL(`../docs/generated/machine-recovery-impact-rate-${RATE}.json`, import.meta.url), JSON.stringify(snap, null, 2));
    expect(Object.keys(snap.controls).length).toBe(9);
    expect(MACHINE_RATE_CURRENT).toBe(RATE);
    expect(machineRatePerHour({})).toBe(RATE);
    expect(machineRatePerHour({ GSO_MACHINE_RATE_PER_HOUR: "6.5" })).toBe(6.5); // env override preserved
    expect(lookupSpektraVendorCost({ size: "4x5x2", material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false, quantity: 1000, skuCount: 1 }).status).toBe("OBSERVED_VENDOR_PRICE");
    if (!CAPTURE) {
      // OWNER APPROVED 2026-10-07: $5/hr for both printers (retail replacement basis, high utilization)
      expect(RATE).toBe(5);
      expect(OWNER_STANDARDS.machineRecoveryPerHour.status).toBe("owner_verified");
    }
  });
});
