// 2026-11-12 — owner-only Staff Access & Launch Readiness page.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReadinessChecks, readinessSummary, type ReadinessInputs } from "../app/lib/owner-readiness";

const h = vi.hoisted(() => ({ sub: "77055393857", counts: { active: 4, missing: 0, white: 0 } }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("../app/db.server", () => {
  const db: any = {
    configuratorProduct: { count: async ({ where }: any) => (where.shopifyProductGid === null ? h.counts.missing : h.counts.active) },
    machineProfileCalibration: { count: async () => h.counts.white },
  };
  return { default: db, db };
});

const READY: ReadinessInputs = {
  ownerIdsConfigured: 1, temporaryAllStaff: false, staffRoleAssignments: 3, authorizedManagers: 1,
  activeConfiguratorProducts: 4, configuratorProductsMissingShopifyIds: 0, mimakiWhiteCalibrationApproved: false,
  jar50mlConfirmed: false, bandSecondsMissingSizes: ["3oz", "4oz"], bannerFinishingUnverified: ["hemmed"], splitBagPackoutModeled: false,
  operationalMigrationActivated: false,
};
const tone = (inputs: ReadinessInputs, key: string) => buildReadinessChecks(inputs).find((c) => c.key === key)?.tone;

describe("readiness checks", () => {
  it("external / manual items are AMBER, never RED (not code failures)", () => {
    const checks = buildReadinessChecks(READY);
    for (const key of ["mimaki-white", "jar-50ml", "jar-band-labor", "banner-finishing", "split-bag-packout", "rush", "wholesale-discount", "stock-bag-storefront", "quickbooks", "messaging", "operational-migration"]) {
      expect(checks.find((c) => c.key === key)?.tone, key).toBe("amber");
    }
    expect(readinessSummary(checks).red).toBe(0);
    expect(checks.find((c) => c.key === "jar-band-labor")?.ownerAction).toContain("3oz and 4oz");
  });

  it("unsafe states are RED: temporary all-staff owner switch, no owner IDs, configurator products without Shopify IDs", () => {
    expect(tone({ ...READY, temporaryAllStaff: true }, "owner-enforcement")).toBe("red");
    expect(tone({ ...READY, ownerIdsConfigured: 0 }, "owner-enforcement")).toBe("red");
    expect(tone({ ...READY, configuratorProductsMissingShopifyIds: 1 }, "configurator-ids")).toBe("red");
    expect(tone(READY, "owner-enforcement")).toBe("green");
    expect(tone({ ...READY, staffRoleAssignments: 0 }, "staff-roles")).toBe("amber"); // no employees yet = safe
  });

  it("resolved items turn GREEN or disappear", () => {
    const done = buildReadinessChecks({ ...READY, mimakiWhiteCalibrationApproved: true, jar50mlConfirmed: true, bandSecondsMissingSizes: [], bannerFinishingUnverified: [], splitBagPackoutModeled: true, operationalMigrationActivated: true });
    expect(done.find((c) => c.key === "mimaki-white")?.tone).toBe("green");
    expect(done.some((c) => c.key === "jar-band-labor" || c.key === "banner-finishing" || c.key === "split-bag-packout")).toBe(false);
  });
});

describe("the page", () => {
  const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: "77055393857", GSO_STAFF_ROLES: "1002:sales,1005:manager", GSO_MANAGER_AUTHORIZED_USER_IDS: "1005" };
  beforeAll(async () => { await import("../app/routes/app.erp.owner-readiness"); }, 120_000);
  beforeEach(() => { Object.assign(process.env, ENV); h.counts = { active: 4, missing: 0, white: 0 }; });
  afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

  async function load(sub: string) {
    h.sub = sub;
    const route: any = await import("../app/routes/app.erp.owner-readiness");
    try { return await route.loader({ request: new Request("https://app.test/app/erp/owner-readiness") }); } catch (thrown) { return thrown; }
  }

  it("is owner only: an authorized manager, sales and unknown staff get 403", async () => {
    for (const sub of ["1005", "1002", "9999"]) {
      const r: any = await load(sub);
      expect(r).toBeInstanceOf(Response);
      expect(r.status, sub).toBe(403);
    }
  });

  it("shows the owner's identity, configured roles and the live checklist (read-only)", async () => {
    h.counts.missing = 1;
    const data: any = await load("77055393857");
    expect(data.viewer).toMatchObject({ userId: "77055393857", role: "owner" });
    expect(data.roles).toEqual([{ userId: "1002", role: "sales" }, { userId: "1005", role: "manager" }]);
    expect(data.authorizedManagers).toEqual(["1005"]);
    expect(data.checks.find((c: any) => c.key === "configurator-ids").tone).toBe("red");
    expect(data.checks.find((c: any) => c.key === "jar-band-labor").detail).toContain("3oz, 4oz");
    expect(data.checks.find((c: any) => c.key === "operational-migration").tone).toBe("amber");
  });
});
