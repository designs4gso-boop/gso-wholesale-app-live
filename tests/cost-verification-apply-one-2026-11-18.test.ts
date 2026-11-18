// 2026-11-18 — Cost Verification: apply ONE approved cost update at a time.
//
// The bulk form applies every pending registry row. The owner needed to apply
// only miron-ceres-50ml and miron-ceres-100ml while miron-50ml and bag-4x6 were
// also pending. These tests pin that the per-item control sends the row's key
// and that the route action then touches exactly that one item.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState: { sub: string } = { sub: "9001" };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: authState.sub }, admin: {} }) },
}));

const state: { vendorProducts: any[]; writes: string[]; seq: number } = { vendorProducts: [], writes: [], seq: 0 };

vi.mock("../app/db.server", () => {
  const vendorProduct = {
    findMany: async () => state.vendorProducts.filter((row) => row.active !== false),
    create: async ({ data }: any) => {
      const id = `vp_new_${++state.seq}`;
      const tiers = (data.tiers?.create ?? []).map((tier: any, i: number) => ({ id: `${id}_t${i}`, ...tier }));
      state.vendorProducts.push({ ...data, id, tiers });
      state.writes.push(`vendorProduct.create:${data.vendorSku}`);
      return { id };
    },
    update: async ({ where, data }: any) => {
      Object.assign(state.vendorProducts.find((row) => row.id === where.id), data);
      state.writes.push(`vendorProduct.update:${where.id}`);
      return {};
    },
  };
  const vendorProductTier = {
    deleteMany: async ({ where }: any) => { state.vendorProducts.find((row) => row.id === where.vendorProductId).tiers = []; state.writes.push(`tier.deleteMany:${where.vendorProductId}`); return {}; },
    createMany: async ({ data }: any) => { for (const tier of data) state.vendorProducts.find((row) => row.id === tier.vendorProductId).tiers.push({ id: `t_${++state.seq}`, ...tier }); state.writes.push(`tier.createMany:${data[0]?.vendorProductId}`); return {}; },
    update: async ({ where, data }: any) => { for (const row of state.vendorProducts) for (const tier of row.tiers) if (tier.id === where.id) Object.assign(tier, data); state.writes.push(`tier.update:${where.id}`); return {}; },
  };
  const other = new Proxy({}, { get: (_t, method: string) => async () => { if (/^(create|update|upsert|delete)/.test(method)) state.writes.push(`other.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "vendorProduct") return vendorProduct;
      if (key === "vendorProductTier") return vendorProductTier;
      if (key === "$transaction") return async (fn: any) => fn(db);
      return other;
    },
  });
  return { default: db, db };
});

import db from "../app/db.server";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { APPLY_CONFIRM_PHRASE } from "../app/lib/cost-verification-shared";
import { APPROVED_COST_TRUTH, applyApprovedCostUpdates, previewApprovedCostUpdates } from "../app/lib/approved-cost-updates.server";
import { ApprovedUpdateApplyOne } from "../app/components/ApprovedUpdateApplyOne";
import { action } from "../app/routes/app.erp.cost-verification";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const GENERIC_50_LADDER = [2.46, 2.24, 2.03, 1.89, 1.74];
const TIER_BOUNDS: Array<[number, number | null]> = [[1, 249], [250, 499], [500, 999], [1000, 2499], [2500, null]];

// Mirrors the production Vendor Cost Book state of 2026-11-17: generic 50ml on its
// old ladder (miron-50ml pending), 4x6 bag with no cost (bag-4x6 pending), no Ceres rows.
function seedProductionLikeBook() {
  state.seq = 0;
  state.writes = [];
  state.vendorProducts = [
    { id: "vp_generic_50", name: "50ml Miron jar + lid", vendor: "Miron", vendorSku: "preset:miron-50ml", defaultUnitCost: 2.46, notes: "", active: true, tiers: TIER_BOUNDS.map(([minQty, maxQty], i) => ({ id: `g50_t${i}`, minQty, maxQty, unitCost: GENERIC_50_LADDER[i] })) },
    { id: "vp_bag_4x6", name: "4x6 Sticker Bag", vendor: "Safe Care", vendorSku: null, defaultUnitCost: 0, notes: "", active: true, tiers: [] },
  ];
}
const snapshot = (id: string) => JSON.stringify(state.vendorProducts.find((row) => row.id === id));
const statusOf = async (key: string) => (await previewApprovedCostUpdates(db, "shop-1")).find((row) => row.key === key)!.status;
const pendingKeys = async () => (await previewApprovedCostUpdates(db, "shop-1")).filter((row) => row.status === "will_update" || row.status === "will_create").map((row) => row.key);
const ceresRows = () => state.vendorProducts.filter((row) => /ceres/i.test(row.name));
const post = (fields: Record<string, string>) => {
  const body = new URLSearchParams(fields);
  return action({ request: new Request("https://app.test/app/erp/cost-verification", { method: "POST", body }) });
};

beforeEach(() => {
  seedProductionLikeBook();
  authState.sub = "9001";
  process.env[OWNER_USER_IDS_ENV] = "9001";
});

describe("1. the per-item control", () => {
  const render = (updateKey: string) => {
    const Stub = createRoutesStub([{ path: "/", Component: () => createElement(ApprovedUpdateApplyOne, { updateKey, label: "MIRON Ceres 50 mL", confirmPhrase: APPLY_CONFIRM_PHRASE, applying: false }) }]);
    return renderToString(createElement(Stub, { initialEntries: ["/"] }));
  };
  it("renders a form that posts the row's exact key as onlyKey, marked single", () => {
    const html = render("miron-ceres-50ml");
    expect(html).toContain('name="onlyKey" value="miron-ceres-50ml"');
    expect(html).toContain('name="applyScope" value="single"');
    expect(html).toContain('name="intent" value="applyApprovedCosts"');
    expect(html).toContain('name="confirmPhrase"');
    expect(html).toContain("Apply only this update");
    expect(html).toContain('method="post"');
  });
  it("renders nothing at all without a key — it can never post an unkeyed apply", () => {
    expect(render("")).not.toContain("<form");
    expect(render("   ")).not.toContain("<form");
  });
  it("the page shows it only on pending rows and labels the bulk form as bulk", () => {
    const route = src("app/routes/app.erp.cost-verification.tsx");
    expect(route).toContain('{row.status === "will_update" || row.status === "will_create"\n                      ? <ApprovedUpdateApplyOne updateKey={row.key} label={row.label} confirmPhrase={APPLY_CONFIRM_PHRASE} applying={applying} />');
    expect(route).toContain("<b>BULK — applies ALL pending rows.</b>");
    expect(route).toContain("`Apply ALL ${willUpdateCount} pending updates`");
  });
});

describe("2. applying one key applies only that key", () => {
  it("starting state: both Ceres sets, miron-50ml and bag-4x6 are all pending", async () => {
    const pending = await pendingKeys();
    for (const key of ["miron-ceres-50ml", "miron-ceres-100ml", "miron-50ml", "bag-4x6"]) expect(pending, key).toContain(key);
    expect(await statusOf("miron-ceres-50ml")).toBe("will_create");
    expect(await statusOf("miron-ceres-100ml")).toBe("will_create");
  });

  it("onlyKey=miron-ceres-50ml creates exactly the Ceres 50 record and nothing else", async () => {
    const generic = snapshot("vp_generic_50");
    const bag = snapshot("vp_bag_4x6");
    const before = await pendingKeys();
    const result: any = await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(result.ok).toBe(true);
    expect(result.applied.map((entry: any) => entry.key)).toEqual(["miron-ceres-50ml"]);
    expect(state.writes).toEqual(["vendorProduct.create:HF10685-204+EGA01A1A021-200"]);
    expect(ceresRows()).toHaveLength(1);
    const row = ceresRows()[0];
    expect(row.name).toBe("MIRON Ceres 50 mL + Yuha 48 (jar + lid set)");
    expect(row.vendorSku).toBe("HF10685-204+EGA01A1A021-200");
    expect(row.tiers.map((tier: any) => tier.unitCost)).toEqual([2.74, 2.52, 2.31, 2.12, 1.98]);
    expect(snapshot("vp_generic_50")).toBe(generic);
    expect(snapshot("vp_bag_4x6")).toBe(bag);
    expect(await pendingKeys()).toEqual(before.filter((key) => key !== "miron-ceres-50ml"));
    expect(await statusOf("miron-ceres-50ml")).toBe("already_correct");
    expect(await statusOf("miron-50ml")).toBe("will_update");
    expect(await statusOf("bag-4x6")).toBe("will_update");
    expect(await statusOf("miron-ceres-100ml")).toBe("will_create");
  });

  it("onlyKey=miron-ceres-100ml creates exactly the Ceres 100 record and nothing else", async () => {
    const generic = snapshot("vp_generic_50");
    const bag = snapshot("vp_bag_4x6");
    const result: any = await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-100ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(result.applied.map((entry: any) => entry.key)).toEqual(["miron-ceres-100ml"]);
    expect(state.writes).toEqual(["vendorProduct.create:HF10657-204+EGA01A1A022-200"]);
    expect(ceresRows()).toHaveLength(1);
    expect(ceresRows()[0].name).toBe("MIRON Ceres 100 mL + Yuha 58 (jar + lid set)");
    expect(ceresRows()[0].tiers.map((tier: any) => tier.unitCost)).toEqual([3.51, 3.24, 2.97, 2.77, 2.6]);
    expect(snapshot("vp_generic_50")).toBe(generic);
    expect(snapshot("vp_bag_4x6")).toBe(bag);
    expect(await statusOf("miron-ceres-50ml")).toBe("will_create");
    expect(await statusOf("miron-50ml")).toBe("will_update");
    expect(await statusOf("bag-4x6")).toBe("will_update");
  });

  it("both applied one after the other: one row each, no duplicates, generic Miron and 4x6 untouched", async () => {
    const generic = snapshot("vp_generic_50");
    const bag = snapshot("vp_bag_4x6");
    await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-100ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(ceresRows().map((row) => row.vendorSku).sort()).toEqual(["HF10657-204+EGA01A1A022-200", "HF10685-204+EGA01A1A021-200"]);
    expect(state.vendorProducts).toHaveLength(4);
    expect(snapshot("vp_generic_50")).toBe(generic);
    expect(snapshot("vp_bag_4x6")).toBe(bag);
    expect(await statusOf("miron-50ml")).toBe("will_update");
    expect(await statusOf("bag-4x6")).toBe("will_update");
  });

  it("is idempotent: re-applying an already-applied key writes nothing and creates no duplicate", async () => {
    await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    state.writes = [];
    const again: any = await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(again.ok).toBe(true);
    expect(again.applied).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(ceresRows()).toHaveLength(1);
  });
});

describe("3. missing or invalid keys are refused with no write", () => {
  it("a single-item post with no key is refused — it does not fall through to bulk", async () => {
    const attempts: Array<Record<string, string>> = [{ applyScope: "single" }, { applyScope: "single", onlyKey: "   " }];
    for (const fields of attempts) {
      const result: any = await post({ intent: "applyApprovedCosts", confirmPhrase: APPLY_CONFIRM_PHRASE, ...fields });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Nothing was applied");
    }
    expect(state.writes).toEqual([]);
  });
  it("an unknown key is refused", async () => {
    const result: any = await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-75ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown approved-cost key");
    expect(state.writes).toEqual([]);
  });
  it("a wrong or missing confirmation phrase is refused", async () => {
    for (const confirmPhrase of ["", "apply verified costs", "APPLY"]) {
      const result: any = await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase });
      expect(result.ok).toBe(false);
    }
    expect(state.writes).toEqual([]);
  });
});

describe("4. authorization is unchanged", () => {
  it("a non-owner is rejected before anything is read or written", async () => {
    authState.sub = "1234";
    let thrown: any = null;
    try {
      await post({ intent: "applyApprovedCosts", applyScope: "single", onlyKey: "miron-ceres-50ml", confirmPhrase: APPLY_CONFIRM_PHRASE });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(403);
    expect(state.writes).toEqual([]);
    expect(ceresRows()).toHaveLength(0);
  });
  it("the owner gate still runs before the form is read", () => {
    const route = src("app/routes/app.erp.cost-verification.tsx");
    const gate = route.indexOf('requireOwner(auth, process.env, "Applying approved cost updates is owner only.");');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(route.indexOf("const formData = await request.formData();"));
  });
});

describe("5. bulk apply is unchanged, and no cost value moved", () => {
  it("a post without applyScope or onlyKey still applies every pending row (existing behaviour)", async () => {
    const before = await pendingKeys();
    const result: any = await post({ intent: "applyApprovedCosts", confirmPhrase: APPLY_CONFIRM_PHRASE });
    expect(result.ok).toBe(true);
    expect(result.applied.map((entry: any) => entry.key).sort()).toEqual([...before].sort());
    // (the in-memory book above only stores vendor products, so only those are re-checked)
    const after = await pendingKeys();
    for (const key of ["miron-ceres-50ml", "miron-ceres-100ml", "miron-50ml", "bag-4x6"]) expect(after, key).not.toContain(key);
  });
  it("the library call with onlyKeys matches the route (same single-item isolation)", async () => {
    const result = await applyApprovedCostUpdates(db, "shop-1", { onlyKeys: ["miron-ceres-100ml"] });
    expect(result.applied.map((entry) => entry.key)).toEqual(["miron-ceres-100ml"]);
  });
  it("registry values for the items involved are the approved ones", () => {
    const tiers = (key: string) => APPROVED_COST_TRUTH.find((item) => item.key === key)!.tiers!.map((tier) => tier.unitCost);
    expect(tiers("miron-ceres-50ml")).toEqual([2.74, 2.52, 2.31, 2.12, 1.98]);
    expect(tiers("miron-ceres-100ml")).toEqual([3.51, 3.24, 2.97, 2.77, 2.6]);
    expect(tiers("miron-50ml")).toEqual([2.47, 2.26, 2.06, 1.93, 1.77]);
    expect(APPROVED_COST_TRUTH.find((item) => item.key === "bag-4x6")!.flatCost).toBe(0.1);
  });
});
