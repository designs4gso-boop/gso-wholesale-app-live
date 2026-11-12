// 2026-11-11 — owner-rule correction pass.
//
//  A. Machine capability + routing matrix (the Mimaki prints White; only gloss
//     forces the Roland) and AUTO load balancing that never invents "less busy".
//  B. Costing vs routing: Mimaki White never borrows Roland calibration and a
//     missing Mimaki White calibration is CALIBRATION_REQUIRED, not unsupported.
//  C. Fixed machine overhead is per physical print run.
//  D. Quote routing and Production routing agree.
//  E. Remaining owner rules: Split Bag MOQ 64, Chiron known costs, fixed jar
//     ladder online, wholesale discount not an ERP authority, raw Stock Bag
//     bypass guarded, historical snapshots untouched.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_CALIBRATION_IDENTITIES,
  CANONICAL_CALIBRATION_IDENTITIES,
  MACHINE_CAPABILITIES,
  PENDING_CALIBRATION_IDENTITIES,
  ROUTING_REASONS,
  compatiblePrinters,
  resolveCanonicalMachineRouting,
} from "../app/lib/machine-routing.server";
import { selectLessBusyPrinter, type MachineLoadSnapshot } from "../app/lib/machine-load-balancing";
import { machineLoadFromItems } from "../app/lib/machine-load.server";
import { PRIMER_NOT_CONFIGURED, decideMachine, decideMachineFromFilename, needsGloss, needsPrimer } from "../app/lib/print-intake-routing.server";
import { computeOccupancyMinutes } from "../app/lib/machine-calibration.server";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  resolveCanonicalMachineInputsFromCache,
  type CalibrationCache,
} from "../app/lib/canonical-calculator.server";
import { SPLIT_BAG_MOQ, BAG_REASONS, bagBlankUnitCostFor, bagLabelPositionsPerSide } from "../app/lib/bag-cost-inputs.server";
import { CHIRON_SET_COST, MIRON_SET_COST, resolveJarBlankCost } from "../app/lib/jar-cost-inputs.server";
import { priceJarConfiguration } from "../app/lib/canonical-jar-pricing";
import {
  configuratorBypassLinesOf,
  configuratorManagedIdsOf,
  costedMachineSummary,
  unverifiedConfiguratorLinesOf,
} from "../app/lib/production-job-source.server";
import { configuratorBypassPaidOrderQueueItem } from "../app/lib/production-alert.server";
import { getProductProductionSpec } from "../app/lib/product-production-spec";

const src = (path: string) => readFileSync(path, "utf8");
const load = (mimaki: number, roland: number, opts: { unattributed?: number; minutes?: [number | null, number | null] } = {}): MachineLoadSnapshot => ({
  source: "test",
  capturedAt: "2026-11-11T00:00:00Z",
  unattributedOpenItems: opts.unattributed ?? 0,
  byPrinter: {
    mimaki: { openItems: mimaki, estimatedMinutes: opts.minutes ? opts.minutes[0] : null },
    roland: { openItems: roland, estimatedMinutes: opts.minutes ? opts.minutes[1] : null },
  },
});
const route = (printerSelection: string, layers: { white?: number; gloss?: number } = {}, extra: Record<string, unknown> = {}) =>
  resolveCanonicalMachineRouting({
    printerSelection,
    whiteLayers: layers.white ?? 0,
    whiteCoveragePct: layers.white ? 90 : null,
    glossLayers: layers.gloss ?? 0,
    ...extra,
  });

/* ------------------------------------------------------------------ */

describe("A. capability matrix + explicit routing", () => {
  it("capabilities: Mimaki CMYK + White, no gloss; Roland everything", () => {
    expect(MACHINE_CAPABILITIES.mimaki).toEqual({ cmyk: true, white: true, gloss: false });
    expect(MACHINE_CAPABILITIES.roland).toEqual({ cmyk: true, white: true, gloss: true });
    expect(compatiblePrinters({ whiteLayers: 1 })).toEqual(["mimaki", "roland"]);
    expect(compatiblePrinters({ glossLayers: 1 })).toEqual(["roland"]);
  });

  it.each([
    ["Mimaki CMYK", "mimaki", {}, "mimaki"],
    ["Mimaki White", "mimaki", { white: 1 }, "mimaki"],
    ["Mimaki CMYK + White", "mimaki", { white: 2 }, "mimaki"],
    ["Roland CMYK", "roland", {}, "roland"],
    ["Roland White", "roland", { white: 1 }, "roland"],
    ["Roland Gloss", "roland", { gloss: 1 }, "roland"],
    ["Roland White + Gloss", "roland", { white: 1, gloss: 1 }, "roland"],
  ] as const)("%s is allowed", (_label, printer, layers, expected) => {
    const r = route(printer, layers);
    expect(r.blockers).toEqual([]);
    expect(r.effectivePrinter).toBe(expected);
    expect(r.overrideApplied).toBe(true);
  });

  it.each([
    ["Mimaki Gloss", { gloss: 1 }],
    ["Mimaki White + Gloss", { white: 1, gloss: 1 }],
  ] as const)("%s is BLOCKED (MIMAKI_GLOSS_UNSUPPORTED)", (_label, layers) => {
    const r = route("mimaki", layers);
    expect(r.reasons).toContain(ROUTING_REASONS.mimakiGlossUnsupported);
    expect(r.effectivePrinter).toBe("roland"); // gloss only exists there; the job is blocked, never priced on the Mimaki
  });

  it("Auto + Gloss -> Roland, with or without load data", () => {
    expect(route("auto", { gloss: 1 }).effectivePrinter).toBe("roland");
    expect(route("auto", { white: 1, gloss: 1 }, { machineLoad: load(0, 99) }).effectivePrinter).toBe("roland");
    expect(route("auto", { gloss: 3 }).autoSelection.status).toBe("gloss_requires_roland");
  });
});

describe("A. AUTO load balancing", () => {
  it("Auto without gloss picks the LESS BUSY compatible press", () => {
    expect(route("auto", {}, { machineLoad: load(7, 2) })).toMatchObject({ effectivePrinter: "roland", autoSelection: { status: "load_balanced" } });
    expect(route("auto", {}, { machineLoad: load(1, 5) })).toMatchObject({ effectivePrinter: "mimaki", autoSelection: { status: "load_balanced" } });
  });

  it("estimated minutes (when complete) outrank item counts", () => {
    const pick = selectLessBusyPrinter(["mimaki", "roland"], load(9, 1, { minutes: [30, 240] }));
    expect(pick).toMatchObject({ ok: true, printer: "mimaki", metric: "estimated_minutes" });
    // one press missing minutes -> falls back to the complete workload count
    expect(selectLessBusyPrinter(["mimaki", "roland"], load(9, 1, { minutes: [30, null] }))).toMatchObject({ ok: true, printer: "roland", metric: "open_workload" });
  });

  it("missing / incomplete / tied load NEVER invents a less busy press", () => {
    for (const machineLoad of [null, undefined, load(0, 3, { unattributed: 1 }), load(4, 4)]) {
      const r = route("auto", {}, { machineLoad });
      expect(r.autoSelection.status).toBe("unavailable");
      expect(r.blockers.join(" ")).toContain(ROUTING_REASONS.autoMachineLoadUnavailable);
    }
  });

  it("explicit compatible operator assignment always wins over load", () => {
    expect(route("mimaki", { white: 1 }, { machineLoad: load(50, 0) }).effectivePrinter).toBe("mimaki");
    expect(route("roland", {}, { machineLoad: load(0, 50) }).effectivePrinter).toBe("roland");
  });

  it("Auto never picks by price: the selector has no cost input, and the router passes none", () => {
    const selector = src("app/lib/machine-load-balancing.ts");
    expect(selector).not.toMatch(/inkCost|unitCost|costPer|price/i);
    // the cheaper-ink Mimaki is not chosen when the Roland is less busy
    expect(route("auto", {}, { machineLoad: load(3, 0) }).effectivePrinter).toBe("roland");
  });

  it("Auto balances only among cost-ready presses (Mimaki White uncalibrated -> Roland)", () => {
    expect(route("auto", { white: 1 }, { costReadyPrinters: ["roland"], machineLoad: load(0, 40) })).toMatchObject({ effectivePrinter: "roland", autoSelection: { status: "single_eligible" } });
  });

  it("the load snapshot is built only from explicitly attributed open items", () => {
    const snapshot = machineLoadFromItems([
      { machineSummary: "Mimaki UCJV300-130", costSnapshot: JSON.stringify({ canonical: { diagnostics: { machineMinutes: 12 } } }) },
      { machineSummary: "Roland LG-640", costSnapshot: JSON.stringify({ canonical: { diagnostics: { machineMinutes: 30 } } }) },
      { machineSummary: "Roland LG-640", costSnapshot: null },
      { machineSummary: null, costSnapshot: null },
    ]);
    expect(snapshot.unattributedOpenItems).toBe(1);
    expect(snapshot.byPrinter.mimaki).toEqual({ openItems: 1, estimatedMinutes: 12 });
    expect(snapshot.byPrinter.roland).toEqual({ openItems: 2, estimatedMinutes: null });
    expect(selectLessBusyPrinter(["mimaki", "roland"], snapshot).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

const approved = (key: keyof typeof ALL_CALIBRATION_IDENTITIES, ml: number, min: number) => ({
  calibration: {
    id: `cal_${key}`, shop: "s", ...ALL_CALIBRATION_IDENTITIES[key],
    mlPerSqftPerPass: ml, inkAreaBasis: "inkable_artwork", minutesPerSqft: min, timeAreaBasis: "rip_layout",
    fixedMinutes: null, timeModel: "variable_only", coverageBasisPct: key.endsWith("cmyk") ? null : 100,
    effectiveFrom: new Date("2026-01-01"), effectiveTo: null, status: "approved", source: "test", notes: null, supersedesId: null,
  } as any,
  message: "approved",
});
// Production reality: the four seeded rows exist; Mimaki White has NONE.
const PROD_CACHE: CalibrationCache = {
  "mimaki-cmyk": approved("mimaki-cmyk", 1.89, 1.444),
  "roland-cmyk": approved("roland-cmyk", 1.4133, 0.91),
  "roland-white": approved("roland-white", 6.0, 1.71),
  "roland-gloss": approved("roland-gloss", 4.18, 0.91),
  "mimaki-white": { calibration: null, message: "No approved calibration for this identity." },
};
const LABEL = (printer: string, extra = "") =>
  `pfamily=stickers-labels&pllines=1&pl0qty=5000&pl0w=1&pl0h=1&pl0mat=matte&pl0art=A&pprinter=${printer}&pwhitelayers=1&pwhitecoverage=90&pglosslayers=0${extra}`;
const cost = (qs: string, cache = PROD_CACHE) => {
  const input = normalizeCanonicalInput(new URLSearchParams(qs))!;
  return assembleCanonicalJob(input, resolveCanonicalMachineInputsFromCache(input, cache));
};

describe("B. costing vs routing", () => {
  it("Mimaki White has its OWN pending identity — never the Roland's, and never seeded", () => {
    expect(PENDING_CALIBRATION_IDENTITIES["mimaki-white"].machineKey).toBe("mimaki-ucjv300-130");
    expect(PENDING_CALIBRATION_IDENTITIES["mimaki-white"]).not.toEqual(CANONICAL_CALIBRATION_IDENTITIES["roland-white"]);
    expect(Object.keys(CANONICAL_CALIBRATION_IDENTITIES)).not.toContain("mimaki-white");
    expect(src("tools/seed-machine-profile-calibrations.mjs")).not.toMatch(/inkMode: "white",\s*\n\s*ripProfile: "Generic PVC Matte v3.5"/);
  });

  it("missing Mimaki White calibration fails CALIBRATION_REQUIRED, not unsupported, and borrows nothing", () => {
    const r = cost(LABEL("mimaki"));
    expect(r.status).toBe("DRAFT_ONLY");
    expect(r.unitCost).toBeNull();
    expect(r.blockers.join(" ")).toContain(ROUTING_REASONS.mimakiWhiteCalibrationRequired);
    expect(r.blockers.join(" ")).not.toMatch(/UNSUPPORTED/);
    const white = r.inkChannels.find((c) => c.kind === "white")!;
    expect(white.calibrationKey).toBe("mimaki-white");
    expect(white.mlPerSqftPerPass).toBeNull();
    expect(white.occupancyMinutes).toBeNull();
  });

  it("an approved Mimaki White row would cost from ITS numbers — machine-specific true cost", () => {
    const withMimakiWhite: CalibrationCache = { ...PROD_CACHE, "mimaki-white": approved("mimaki-white", 1.36, 3.24) };
    const mimaki = cost(LABEL("mimaki"), withMimakiWhite);
    const roland = cost(LABEL("roland"), withMimakiWhite);
    expect(mimaki.status).not.toBe("DRAFT_ONLY");
    expect(mimaki.inkChannels.find((c) => c.kind === "white")!.mlPerSqftPerPass).toBe(1.36);
    expect(roland.inkChannels.find((c) => c.kind === "white")!.mlPerSqftPerPass).toBe(6.0);
    expect(mimaki.totalCost).not.toBeCloseTo(roland.totalCost, 2);
  });

  it("AUTO white quote with only the Roland calibrated routes Roland (the live Clear Material behaviour)", () => {
    const r = cost(LABEL("auto"));
    expect(r.routing.effectivePrinter).toBe("roland");
    expect(r.routing.autoSelection.status).toBe("single_eligible");
    expect(r.blockers).toEqual([]);
  });

  it("missing white coverage still BLOCKS on either press — never assumed 100%", () => {
    for (const printer of ["mimaki", "roland"]) {
      const r = route(printer, {}, { whiteLayers: 1, whiteCoveragePct: null });
      expect(r.reasons).toContain(ROUTING_REASONS.whiteCoverageRequired);
    }
  });
});

describe("C. fixed machine overhead is per physical print run", () => {
  const cal = { ...approved("roland-white", 6, 1).calibration, timeModel: "fixed_plus_variable", fixedMinutes: 10 };
  it("the run's base channel carries the fixed overhead once; a specialty channel in the same run adds variable time only", () => {
    const areas = { rip_layout: 2 };
    const base = computeOccupancyMinutes({ calibration: cal, areas, passCount: 1 }) as any;
    const specialty = computeOccupancyMinutes({ calibration: cal, areas, passCount: 2, includeFixedMinutes: false }) as any;
    expect(base.minutes).toBeCloseTo(10 + 2, 10);
    expect(specialty.minutes).toBeCloseTo(2 * 2, 10);
    expect(specialty.fixedMinutesApplied).toBe(0);
  });
  it("the canonical calculator passes includeFixedMinutes only for the base channel", () => {
    expect(src("app/lib/canonical-calculator.server.ts")).toContain("includeFixedMinutes: channel.isBase,");
  });
});

describe("D. quote routing and Production routing agree", () => {
  const item = (o: Record<string, unknown>) => ({ id: "i", itemTicket: null, ripJobName: null, suggestedFileName: null, productTitle: "x", selectedFinish: null, materialSummary: null, machineSummary: null, ...o }) as any;
  it.each([
    ["gloss", { selectedFinish: "Spot Gloss" }, { gloss: 1 }],
    ["explicit Mimaki white", { selectedFinish: "White ink", machineSummary: "Mimaki UCJV300-130" }, { white: 1 }, "mimaki"],
    ["explicit Roland CMYK", { machineSummary: "Roland LG-640" }, {}, "roland"],
  ] as const)("%s", (_l, prod, layers, printer: string = "auto") => {
    const quote = route(printer, layers);
    const production = decideMachine(item(prod));
    expect(production.machine).toBe(quote.effectivePrinter);
  });
  it("Auto non-gloss with the same load picks the same press in both; with no load both refuse to guess", () => {
    const l = load(6, 1);
    expect(decideMachine(item({}), "", l).machine).toBe(route("auto", {}, { machineLoad: l }).effectivePrinter);
    expect(decideMachine(item({})).machine).toBeNull();
    expect(route("auto").autoSelection.status).toBe("unavailable");
    expect(decideMachineFromFilename("Cust_matte.pdf").machine).toBeNull();
  });
  it("a converted quote carries the press it was COSTED on (historical snapshot authority, not re-routing)", () => {
    // a pre-2026-11-11 snapshot costed AUTO CMYK on the Mimaki keeps the Mimaki
    expect(costedMachineSummary(JSON.stringify({ canonical: { status: "PROVISIONAL", routing: { printerSelection: "auto", effectivePrinter: "mimaki" } } }))).toBe("Mimaki UCJV300-130");
    expect(costedMachineSummary(JSON.stringify({ canonical: { status: "READY", routing: { effectivePrinter: "roland" } } }))).toBe("Roland LG-640");
    expect(costedMachineSummary(JSON.stringify({ canonical: { status: "DRAFT_ONLY", routing: { effectivePrinter: "mimaki" } } }))).toBeNull();
    expect(costedMachineSummary(null)).toBeNull();
  });
  it("stated zero layers in a canonical summary are never read as gloss", () => {
    expect(decideMachine(item({ materialSummary: "Gloss Layers: 0X | White Layers: 1" }), "", load(0, 3)).machine).toBe("mimaki");
    expect(decideMachine(item({ materialSummary: "Gloss Layers: 2X" })).machine).toBe("roland");
  });
});

/* ------------------------------------------------------------------ */

describe("E. Split Bag", () => {
  it("MOQ 64 blocks below, allows at 64", () => {
    expect(SPLIT_BAG_MOQ).toBe(64);
    const qs = (qty: number) => `pfamily=sticker-bags&pbagmat=matte&psplitbag=1&pblank=preset%3Asplit-bag&pqty=${qty}&pfaces=1&pbagsides=1&pdesigns=1&pwidth=4&pheight=5&pcut=square-rect&pprinter=mimaki&pwhitelayers=0&pglosslayers=0`;
    const below = cost(qs(63));
    expect(below.family).toBe("split-bags");
    expect(below.reasons).toContain(BAG_REASONS.splitBagBelowMoq);
    expect(cost(qs(64)).reasons).not.toContain(BAG_REASONS.splitBagBelowMoq);
    expect(getProductProductionSpec("split-bags", "split-bag")?.moqNote).toMatch(/MOQ 64/);
  });
  it("one $0.25 blank; ONE label per printed side (owner correction — never 4 per bag)", () => {
    expect(bagBlankUnitCostFor("split_bag")).toBe(0.25);
    expect(bagLabelPositionsPerSide("split_bag")).toBe(1);
  });
  it("selling price stays provisional (no invented ladder)", () => {
    expect(getProductProductionSpec("split-bags", "split-bag")?.pricingSource).toMatch(/no owner-approved selling price/);
  });
});

describe("E. jars", () => {
  it("known Chiron flat blank jar+cap costs are preserved; unknown Chiron blocks and never borrows Miron", () => {
    expect(CHIRON_SET_COST).toMatchObject({ "100ml_tall": 1.8, "100ml_wide": 1.8, "150ml": 1.9 });
    for (const quantity of [1, 500, 5000]) {
      expect(resolveJarBlankCost({ brand: "chiron", size: "150ml", quantity })).toMatchObject({ ok: true, unitCost: 1.9 });
    }
    const unknown = resolveJarBlankCost({ brand: "chiron", size: "50ml", quantity: 500 });
    expect(unknown.ok).toBe(false);
    expect(MIRON_SET_COST["50ml"]).toEqual([2.47, 2.26, 2.06, 1.93, 1.77]);
  });
  it("the fixed owner jar ladder is the online price — no cost or margin floor is read", () => {
    const r = priceJarConfiguration({ productType: "jar_100ml_tall", quantity: 128, baseFinish: "Matte", labelMaterial: "Standard", specialty: "Standard — 0X" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unitPrice).toBe(r.basePrice);
    const pricer = src("app/lib/canonical-jar-pricing.ts");
    expect(pricer).not.toMatch(/marginFloor|floorPct|JAR_FLOOR|trueCost|computeTrueJobCost/);
  });
});

describe("E. storefront authority", () => {
  it("the old Wholesale Pricing automatic discount is not an ERP pricing authority (checkout never reads it)", () => {
    const checkout = src("app/routes/apps.wholesale-lite.configurator-checkout.ts");
    expect(checkout).not.toMatch(/wholesale\.server|WholesaleRule|wholesaleRule|discountConfig/);
  });

  it("raw variants of configurator-only products are detected by Shopify ID and held for the OWNER", () => {
    const managed = configuratorManagedIdsOf([
      { shopifyProductGid: "gid://shopify/Product/111", shopifyVariantGid: "gid://shopify/ProductVariant/222" },
      { shopifyProductGid: null, shopifyVariantGid: null },
    ]);
    const order = {
      id: 1, name: "#1013",
      line_items: [
        { title: "4x5 Stock Bag", product_id: 111, variant_id: 999, quantity: 50, price: "1.00", properties: [] },
        { title: "Unrelated tee", product_id: 555, variant_id: 556, quantity: 1, price: "20.00", properties: [] },
      ],
    };
    const bypass = configuratorBypassLinesOf(order, managed);
    expect(bypass.map((l) => l.title)).toEqual(["4x5 Stock Bag"]);
    expect(unverifiedConfiguratorLinesOf(order)).toEqual([]); // raw, unconfigured -> not the old "unverified price" path
    const item = configuratorBypassPaidOrderQueueItem("shop", order, bypass);
    expect(item).toMatchObject({ source: "shopify_order_configurator_bypass", reviewLevel: "owner_review" });
    expect(item.recommendedStaffAction).toMatch(/do NOT produce at the raw variant price/);
  });

  it("the paid-order webhook holds bypass orders before any production job is created", () => {
    const webhook = src("app/routes/webhooks.orders_paid.tsx");
    const hold = webhook.indexOf("configuratorBypassPaidOrderQueueItem(shop, order, bypassLines)");
    const create = webhook.indexOf("createProductionJobFromSource(db, {");
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(create);
  });
});

/* ---- owner signoff follow-up (2026-11-11) ---- */
import { CALIBRATION_PROVENANCE, OWNER_CONFIRMED_PROFILE_ALIASES, calibrationKeyForObservedProfile } from "../app/lib/machine-routing.server";
import { mimakiWhiteCalibrationEvidence } from "../app/lib/mimaki-white-evidence.server";
import { BAG_4X5_CUTLINE_IN } from "../app/lib/bag-artboard-geometry";

describe("Mimaki CMYK profile identity — provenance kept, mismatches fail closed", () => {
  it("the seeded identity is unchanged (measured profile), and its application to the production profile is disclosed as pending", () => {
    expect(CANONICAL_CALIBRATION_IDENTITIES["mimaki-cmyk"].ripProfile).toBe("PVC Gloss / Mimaki Vision Vinyl");
    expect(src("tools/seed-machine-profile-calibrations.mjs")).toContain('ripProfile: "PVC Gloss / Mimaki Vision Vinyl"');
    expect(CALIBRATION_PROVENANCE["mimaki-cmyk"]).toMatchObject({ measuredOnProfile: "PVC Gloss / Mimaki Vision Vinyl", observedProductionProfiles: ["Generic PVC Matte v3.5"], status: "APPLIED_TO_UNMEASURED_PROFILE_PENDING_OWNER_CONFIRMATION" });
    const r = cost(LABEL("mimaki").replace("pwhitelayers=1&pwhitecoverage=90", "pwhitelayers=0"));
    expect(r.calibration.message).toContain("PROVENANCE: Measured 2026-08-18 on PVC Gloss / Mimaki Vision Vinyl");
  });
  it("observed RIP profiles map only to their exact measured identity or an owner-confirmed alias (none yet)", () => {
    expect(OWNER_CONFIRMED_PROFILE_ALIASES).toEqual({});
    expect(calibrationKeyForObservedProfile("mimaki-cmyk", "PVC Gloss / Mimaki Vision Vinyl")).toBe("mimaki-cmyk");
    expect(calibrationKeyForObservedProfile("mimaki-cmyk", "Generic PVC Matte v3.5")).toBeNull();
    expect(calibrationKeyForObservedProfile("mimaki-cmyk", "")).toBeNull();
  });
});

describe("Mimaki White calibration stays NOT activated; future evidence is captured without fabrication", () => {
  it("no Mimaki White rate exists anywhere in code or seed", () => {
    expect(Object.keys(CANONICAL_CALIBRATION_IDENTITIES)).not.toContain("mimaki-white");
    for (const file of ["app/lib/machine-routing.server.ts", "tools/seed-machine-profile-calibrations.mjs", "app/lib/canonical-calculator.server.ts"]) {
      expect(src(file), file).not.toMatch(/mlPerSqftPerPass:\s*1\.(36|86)\b/);
    }
  });
  it("a fully captured, ERP-linked Mimaki White print yields a normalized rate; nothing is invented when fields are missing", () => {
    const full = mimakiWhiteCalibrationEvidence(
      { jobTicket: "GSO-20261120-0001-01", machineName: "Mimaki UCJV300-130", mediaName: "Generic PVC Matte v3.5", sqft: 7, whiteInkMl: 0, printMinutes: 24, completedAt: "2026-11-20T10:00:00Z",
        rawRow: JSON.stringify({ _gso: { outputScanWidthIn: 48, outputFeedLengthIn: 24, whiteSummedMl: 12, resolution: "600x1200", passCount: 32, quality: "Fast Print High" } }) },
      { costSnapshot: JSON.stringify({ canonical: { routing: { whiteLayers: 1, effectivePrinter: "mimaki" }, inkChannels: [{ kind: "white", passes: 1, coveragePct: 60 }] } }) },
    )!;
    expect(full).toMatchObject({ layoutSqft: 8, layoutSource: "rip_output_dimensions", whiteMl: 12, whiteCoverageSource: "quote_operator_estimate", missing: [], calibrationUsable: true });
    expect(full.normalizedWhiteMlPerSqftAt100).toBeCloseTo(12 / (8 * 0.6 * 1), 10);
    const bare = mimakiWhiteCalibrationEvidence({ sourceJobName: "pbb_w.pdf", machineName: "Mimaki UCJV300", whiteInkMl: 14.8, sqft: 6.5, printMinutes: 21 })!;
    expect(bare.calibrationUsable).toBe(false);
    expect(bare.normalizedWhiteMlPerSqftAt100).toBeNull();
    expect(bare.missing).toEqual(expect.arrayContaining(["White coverage % (link the print to its ERP item)", "White layer count (link the print to its ERP item)", "resolution (converter column not supplied)", "pass config (converter column not supplied)", "RIP profile / media"]));
    expect(mimakiWhiteCalibrationEvidence({ machineName: "Roland LG-640" })).toBeNull();
  });
});

describe("Primer is not configured on either press (owner decision 2026-11-11)", () => {
  const item = (o: Record<string, unknown>) => ({ id: "i", itemTicket: null, ripJobName: null, suggestedFileName: null, productTitle: "x", selectedFinish: null, materialSummary: null, machineSummary: null, ...o }) as any;
  const MIMAKI_IDLE = { source: "test", capturedAt: "2026-11-11T00:00:00Z", unattributedOpenItems: 0, byPrinter: { mimaki: { openItems: 0, estimatedMinutes: 0 }, roland: { openItems: 3, estimatedMinutes: 90 } } };
  it("a requested Primer reviews with PRIMER_NOT_CONFIGURED — never Roland, never Mimaki", () => {
    expect(PRIMER_NOT_CONFIGURED).toBe("PRIMER_NOT_CONFIGURED");
    expect(decideMachine(item({ selectedFinish: "Primer + CMYK" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideMachine(item({ selectedFinish: "Primer + Gloss" })).reasons).toEqual([PRIMER_NOT_CONFIGURED]);
  });
  it("an explicit press, a filename tag or load data cannot route Primer work", () => {
    expect(decideMachine(item({ selectedFinish: "Primer", machineSummary: "Roland LG-640" })).machine).toBeNull();
    expect(decideMachine(item({ selectedFinish: "Primer", machineSummary: "Mimaki UCJV300-130" })).machine).toBeNull();
    expect(decideMachine(item({ materialSummary: "Finish: primer" }), "GSO-1_ROLAND.pdf").reasons).toEqual([PRIMER_NOT_CONFIGURED]);
    expect(decideMachine(item({ selectedFinish: "Primer" }), "GSO-1_MIMAKI.pdf", MIMAKI_IDLE).machine).toBeNull();
    expect(decideMachine(item({ selectedFinish: "Primer" }), "", MIMAKI_IDLE).machine).toBeNull();
    expect(decideMachine(item({ selectedFinish: "CMYK" }), "", MIMAKI_IDLE).machine).toBe("mimaki"); // same load routes non-Primer work
  });
  it("Primer is detected but no longer counted as gloss; Gloss alone still forces the Roland", () => {
    expect(needsPrimer(item({ selectedFinish: "Primer" }))).toBe(true);
    expect(needsGloss(item({ selectedFinish: "Primer" }))).toBe(false);
    expect(decideMachine(item({ selectedFinish: "Gloss" }))).toMatchObject({ machine: "roland", machineRule: "gloss_requires_roland" });
  });
});

describe("Split Bag owner rules unchanged", () => {
  it("MOQ 64, $0.25 blank, 1 label per printed side, 4x5 cutline untouched, packout unmodeled, freight separate, price provisional", () => {
    expect(SPLIT_BAG_MOQ).toBe(64);
    expect(bagBlankUnitCostFor("split_bag")).toBe(0.25);
    expect(bagLabelPositionsPerSide("split_bag")).toBe(1); // front + back = 2 labels, never 4
    expect(BAG_4X5_CUTLINE_IN).toEqual({ widthIn: 3.79, heightIn: 4.81 });
    const spec = getProductProductionSpec("split-bags", "split-bag")!;
    expect(spec.moqNote).toMatch(/Packout is not modeled/);
    expect(spec.moqNote).toMatch(/freight are never assumed/);
    expect(spec.pricingSource).toMatch(/no owner-approved selling price/);
  });
});
