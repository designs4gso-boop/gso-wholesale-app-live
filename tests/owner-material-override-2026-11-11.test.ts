// 2026-11-11 — owner job-level material $/sqft override (owner-approved).
//
// Owner-only, explicit value + required reason, this quote/job only, server
// recomputed, labelled OVERRIDE, recorded in the snapshot, never written to
// Material Center / VendorProduct / standards, never invents geometry.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleCanonicalJob,
  normalizeCanonicalInput,
  resolveCanonicalMachineInputsFromCache,
  type CalibrationCache,
} from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { MATERIAL_OVERRIDE_REASONS, applyOwnerMaterialOverride } from "../app/lib/material-override.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";

const ENV = { [OWNER_USER_IDS_ENV]: "77055393857" };
const OWNER = { session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: "77055393857" } };
const STAFF = { session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: "12345" } };

const row = (key: keyof typeof CANONICAL_CALIBRATION_IDENTITIES, ml: number, min: number) => ({
  calibration: {
    id: `cal_${key}`, shop: "shop-1", ...CANONICAL_CALIBRATION_IDENTITIES[key],
    mlPerSqftPerPass: ml, inkAreaBasis: "inkable_artwork", minutesPerSqft: min, timeAreaBasis: "rip_layout",
    fixedMinutes: null, timeModel: "variable_only", coverageBasisPct: null,
    effectiveFrom: new Date("2026-01-01"), effectiveTo: null, status: "approved", source: "test", notes: null, supersedesId: null,
  } as any,
  message: "approved",
});
const CACHE: CalibrationCache = { "mimaki-cmyk": row("mimaki-cmyk", 1.89, 1.444), "roland-cmyk": row("roland-cmyk", 1.4133, 0.91) };

/** A Material Center record with geometry but NO verified cost (cost under review). */
const UNCOSTED = { id: "m_new", shop: "shop-1", name: "New Clear Film", rollWidthIn: 54, active: true, useInRecipes: true, costPerSqft: null, costUnderReview: true };
const NO_WIDTH = { id: "m_nowidth", shop: "shop-1", name: "Mystery Film", rollWidthIn: null };

function recordingDb(records: any[]) {
  const calls: string[] = [];
  const db: any = new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, method: string) => async (args: any) => {
        calls.push(`${model}.${method}`);
        if (model === "material" && method === "findFirst") return records.find((r) => r.id === args?.where?.id && r.shop === args?.where?.shop) ?? null;
        if (model === "material" && method === "findMany") return [];
        return null;
      },
    }),
  });
  return { db, calls };
}

const LABEL = (mat: string, extra = "") =>
  `pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0mat=${encodeURIComponent(mat)}&pl0art=A&pprinter=mimaki&pwhitelayers=0&pglosslayers=0${extra}`;
const OVR = (value: string, reason = "Vendor invoice pending; owner quote from supplier email 11/11") =>
  `&pmatovr=${value}&pmatovrreason=${encodeURIComponent(reason)}`;

async function run(qs: string, auth: any, records: any[] = [UNCOSTED, NO_WIDTH]) {
  const { db, calls } = recordingDb(records);
  const input = await applyOwnerMaterialOverride({ db, shop: "shop-1" }, normalizeCanonicalInput(new URLSearchParams(qs))!, auth, ENV);
  const result = assembleCanonicalJob(input, resolveCanonicalMachineInputsFromCache(input, CACHE));
  return { input, result, calls };
}

describe("owner job-level material $/sqft override", () => {
  it("an uncosted Material Center material blocks without the override (no $0, no fallback)", async () => {
    const { result } = await run(LABEL("material:m_new"), OWNER);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.unitCost).toBeNull();
    expect(result.materialOverride).toBeNull();
  });

  it("the OWNER's override costs that job on the server, labelled OVERRIDE, with the record's own roll width", async () => {
    const { result } = await run(LABEL("material:m_new", OVR("0.45")), OWNER);
    expect(result.status).not.toBe("DRAFT_ONLY");
    expect(result.reasons).toContain(MATERIAL_OVERRIDE_REASONS.applied);
    expect(result.materialOverride).toMatchObject({ costPerSqft: 0.45, ownerUserId: "77055393857", replacedMaterialKey: "material:m_new", replacedMaterialLabel: "New Clear Film", rollWidthIn: 54 });
    expect(result.trueCost.lines.some((line: any) => /OWNER OVERRIDE/.test(String(line.label)) || /OVERRIDE/.test(String(line.source ?? line.note ?? "")))).toBe(true);
  });

  it("the server recomputes from the value — material cost scales with it; nothing posted is trusted", async () => {
    const low = (await run(LABEL("material:m_new", OVR("0.40")), OWNER)).result;
    const high = (await run(LABEL("material:m_new", OVR("0.80")), OWNER)).result;
    expect(high.totalCost).toBeGreaterThan(low.totalCost);
    const posted = (await run(LABEL("material:m_new", OVR("0.40") + "&ptotal=1&punitcost=0.0001"), OWNER)).result;
    expect(posted.totalCost).toBeCloseTo(low.totalCost, 10);
  });

  it("overrides an approved roll for this job only — the approved rate itself is untouched", async () => {
    const normal = (await run(LABEL("matte"), OWNER)).result;
    const overridden = (await run(LABEL("matte", OVR("1.25")), OWNER)).result;
    expect(overridden.totalCost).toBeGreaterThan(normal.totalCost);
    expect((await run(LABEL("matte"), OWNER)).result.totalCost).toBeCloseTo(normal.totalCost, 10); // never becomes a default
  });

  it("non-owners are refused — the job blocks instead of silently ignoring the request", async () => {
    const { result } = await run(LABEL("matte", OVR("0.45")), STAFF);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.ownerOnly);
    expect(result.materialOverride).toBeNull();
  });

  it("a request that never passed the server owner check blocks too (forged input)", () => {
    const input = normalizeCanonicalInput(new URLSearchParams(LABEL("matte", OVR("0.45"))))!;
    const result = assembleCanonicalJob(input, resolveCanonicalMachineInputsFromCache(input, CACHE));
    expect(result.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.ownerOnly);
  });

  it.each([
    ["missing value", "", "Vendor invoice pending for this film"],
    ["zero", "0", "Vendor invoice pending for this film"],
    ["negative", "-1", "Vendor invoice pending for this film"],
    ["absurd", "500", "Vendor invoice pending for this film"],
    ["missing reason", "0.45", ""],
    ["too-short reason", "0.45", "temp"],
  ])("invalid request (%s) blocks", async (_label, value, reason) => {
    const { result } = await run(LABEL("matte", OVR(value, reason)), OWNER);
    expect(result.status).toBe("DRAFT_ONLY");
    expect(result.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.invalid);
  });

  it("geometry is never invented: no roll width blocks", async () => {
    const { result } = await run(LABEL("material:m_nowidth", OVR("0.45")), OWNER);
    expect(result.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.geometryRequired);
  });

  it("one material per job: a mixed-material job refuses the override", async () => {
    const qs = LABEL("matte", OVR("0.45")).replace("pllines=1", "pllines=2") + "&pl1qty=500&pl1w=2&pl1h=2&pl1mat=gloss&pl1art=B";
    const { result } = await run(qs, OWNER);
    expect(result.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.singleMaterial);
  });

  it("bag and jar label media accept it; banners refuse it", async () => {
    const bag = (await run(`pfamily=sticker-bags&pbagmat=matte&pqty=100&pbagsides=1&pdesigns=1&pprinter=mimaki${OVR("0.60")}`, OWNER)).result;
    expect(bag.materialOverride?.costPerSqft).toBe(0.6);
    const jar = (await run(`pfamily=premium-jars&pjarmat=matte&pprinter=mimaki&pqty=128&pjar=miron/100ml_tall&pjarside=1&pjarlid=1&pcmykcoverage=40${OVR("0.60")}`, OWNER)).result;
    expect(jar.materialOverride?.costPerSqft).toBe(0.6);
    const banner = (await run(`pfamily=banners&pprinter=mimaki&pqty=1&pbannerw=36&pbannerh=60&pdesigns=1${OVR("0.60")}`, OWNER)).result;
    expect(banner.blockers.join(" ")).toContain(MATERIAL_OVERRIDE_REASONS.unsupportedFamily);
  });

  it("never writes anything: only a shop-scoped material READ happens", async () => {
    const { calls } = await run(LABEL("material:m_new", OVR("0.45")), OWNER);
    expect(calls.every((call) => /\.(findFirst|findMany)$/.test(call))).toBe(true);
    expect(calls.some((call) => /vendorProduct|ownerConfig|update|create|upsert|delete/i.test(call))).toBe(false);
  });

  it("a later Material Center change cannot alter an overridden job (the value, not the record cost, is used)", async () => {
    const before = (await run(LABEL("material:m_new", OVR("0.45")), OWNER)).result;
    const after = (await run(LABEL("material:m_new", OVR("0.45")), OWNER, [{ ...UNCOSTED, costPerSqft: 9.99, costUnderReview: false }])).result;
    expect(after.totalCost).toBeCloseTo(before.totalCost, 10);
  });
});

describe("route wiring and the immutable audit record", () => {
  const route = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
  it("loader AND save apply the override on the server, after material verification", () => {
    expect(route.match(/await applyOwnerMaterialOverride\(\{ db, shop \}, \{ \.\.\.\(await attachVerifiedLabelMaterials/g)).toHaveLength(2);
  });
  it("the saved snapshot records value, reason, owner and time as OVERRIDE", () => {
    expect(route).toContain('? { ...canonicalSnapshot.materialOverride, label: "OVERRIDE", appliedAt: new Date().toISOString(), scope: "this quote/job only" }');
  });
  it("the page that offers the control is owner-gated, and the result shows OVERRIDE", () => {
    expect(route).toMatch(/export async function loader[\s\S]{0,200}requireOwner\(auth\);/);
    expect(route).toMatch(/export async function action[\s\S]{0,200}requireOwner\(auth\);/);
    expect(route).toContain("OVERRIDE — owner material cost $");
  });
  it("the override module never touches Material Center, vendor costs or standards", () => {
    const mod = readFileSync("app/lib/material-override.server.ts", "utf8");
    expect(mod).not.toMatch(/\.(update|create|upsert|delete)(Many)?\(/);
    expect(mod).not.toMatch(/vendorProduct|ownerConfig|APPROVED_ROLL_COSTS\s*=/);
  });
});
