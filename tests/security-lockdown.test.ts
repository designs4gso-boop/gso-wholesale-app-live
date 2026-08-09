// Phase 15G.1 — security / data-safety lockdown tests.
// Pure helpers + fake-db scoped-write proofs + repo source pins. No Prisma,
// no Shopify, no server-module imports (repo test convention).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_COST_FIELDS,
  MARGIN_REVIEW_PUSH_WARNING,
  OWNER_RESET_SETTINGS_PHRASE,
  OWNER_SHOPIFY_PRICE_PUSH_PHRASE,
  PUBLIC_CHECKOUT_ERROR_MESSAGE,
  RESET_PILOT_DATA_PHRASE,
  buildAdminResetWhere,
  deleteOwnedRecord,
  isProtectedSettingKey,
  phraseGateOk,
  publicCheckoutFailure,
  resettableSettingKeys,
  sanitizeDraftOrderUserErrors,
  stripInternalCostFields,
  updateOwnedRecord,
} from "../app/lib/security-guards-shared";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// ---------- public payload hygiene ----------

describe("stripInternalCostFields", () => {
  it("removes every internal cost/margin field at any depth and keeps customer-facing pricing", () => {
    const payload = {
      ok: true,
      pricing: {
        priceEach: 1.75,
        orderTotal: 112,
        costEach: 0.6,
        totalCost: 38.4,
        totalProfit: 73.6,
        margin: 65.7,
        priceBreaks: [
          { range: "64-256", priceEach: 1.75, costEach: 0.6 },
          { range: "257-640", priceEach: 1.65 },
        ],
      },
      items: [{ pricing: { priceEach: 2, marginPct: 55, unitCost: 0.9 } }],
      nested: { deep: { accessToken: "shpat_secret", stack: "Error: boom" } },
    };

    const publicPayload = stripInternalCostFields(payload) as any;
    const serialized = JSON.stringify(publicPayload);

    expect(publicPayload.pricing.priceEach).toBe(1.75);
    expect(publicPayload.pricing.orderTotal).toBe(112);
    expect(publicPayload.pricing.priceBreaks[0].priceEach).toBe(1.75);
    for (const field of INTERNAL_COST_FIELDS) {
      expect(serialized.includes(`"${field}"`)).toBe(false);
    }
    expect(serialized.includes("shpat_secret")).toBe(false);
    expect(serialized.includes("Error: boom")).toBe(false);
  });

  it("passes primitives and arrays through and never throws on cycles", () => {
    expect(stripInternalCostFields(null)).toBeNull();
    expect(stripInternalCostFields(7)).toBe(7);
    const cyclic: any = { ok: true };
    cyclic.self = cyclic;
    expect(() => stripInternalCostFields(cyclic)).not.toThrow();
  });
});

describe("checkout error sanitization", () => {
  it("returns only the fixed customer-safe failure body", () => {
    const failure = publicCheckoutFailure();
    expect(failure).toEqual({ ok: false, error: PUBLIC_CHECKOUT_ERROR_MESSAGE });
    const serialized = JSON.stringify(failure);
    expect(serialized.includes("stack")).toBe(false);
    expect(serialized.includes("accessToken")).toBe(false);
  });

  it("sanitizes draftOrderCreate userErrors to plain field/message rows", () => {
    const sanitized = sanitizeDraftOrderUserErrors([
      { field: ["input", "email"], message: "Email is invalid", extensions: { code: "X" }, stack: "boom" },
      { field: null, message: "Line item quantity must be positive" },
      "garbage",
    ]);
    expect(sanitized).toEqual([
      { field: "input.email", message: "Email is invalid" },
      { field: null, message: "Line item quantity must be positive" },
      { field: null, message: "Invalid input." },
    ]);
    const serialized = JSON.stringify(sanitized);
    expect(serialized.includes("stack")).toBe(false);
    expect(serialized.includes("extensions")).toBe(false);
    expect(sanitizeDraftOrderUserErrors("not-an-array")).toEqual([]);
    expect(sanitizeDraftOrderUserErrors(new Array(30).fill({ message: "x" })).length).toBe(10);
  });
});

// ---------- typed confirmation phrases ----------

describe("phraseGateOk", () => {
  it("blocks wrong/missing phrases and allows the exact phrase (trimmed)", () => {
    expect(phraseGateOk("", OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(false);
    expect(phraseGateOk(null, OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(false);
    expect(phraseGateOk("owner shopify price push", OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(false);
    expect(phraseGateOk("OWNER SHOPIFY PRICE PUSH!", OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(false);
    expect(phraseGateOk("OWNER SHOPIFY PRICE PUSH", OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(true);
    expect(phraseGateOk("  OWNER SHOPIFY PRICE PUSH  ", OWNER_SHOPIFY_PRICE_PUSH_PHRASE)).toBe(true);
    expect(phraseGateOk("anything", "")).toBe(false);
  });

  it("pins the owner phrases and warning copy", () => {
    expect(OWNER_SHOPIFY_PRICE_PUSH_PHRASE).toBe("OWNER SHOPIFY PRICE PUSH");
    expect(OWNER_RESET_SETTINGS_PHRASE).toBe("OWNER RESET SETTINGS");
    expect(RESET_PILOT_DATA_PHRASE).toBe("RESET STOCK BAG PILOT");
    expect(MARGIN_REVIEW_PUSH_WARNING).toContain("under recalibration");
  });
});

// ---------- Admin Settings reset protection ----------

describe("admin reset protection", () => {
  it("marks ownerConfig and pricingIntelligence keys as protected", () => {
    expect(isProtectedSettingKey("ownerConfig.pricing.marginCurves")).toBe(true);
    expect(isProtectedSettingKey("ownerConfig.pricing.marketTargets")).toBe(true);
    expect(isProtectedSettingKey("pricingIntelligence.liveFrom")).toBe(true);
    expect(isProtectedSettingKey("pricingIntelligence.shopifyEvidence")).toBe(true);
    expect(isProtectedSettingKey("anything", "OwnerConfig")).toBe(true);
    expect(isProtectedSettingKey("jobTicketPrefix")).toBe(false);
    expect(isProtectedSettingKey("defaultWholesaleMarginPct", "Pricing")).toBe(false);
  });

  it("filters protected keys out of the resettable list even if a definition slips in", () => {
    const keys = resettableSettingKeys([
      "jobTicketPrefix",
      "roundPricesTo",
      "ownerConfig.pricing.marginCurves",
      "pricingIntelligence.liveFrom",
      "jobTicketPrefix",
      " ",
    ]);
    expect(keys).toEqual(["jobTicketPrefix", "roundPricesTo"]);
  });

  it("builds a delete filter that always names explicit keys — never a bare shop wipe", () => {
    const where = buildAdminResetWhere("shop.myshopify.com", ["jobTicketPrefix", "pricingIntelligence.liveFrom"]);
    expect(where).toEqual({ shop: "shop.myshopify.com", key: { in: ["jobTicketPrefix"] } });
    expect(buildAdminResetWhere("", ["jobTicketPrefix"])).toBeNull();
    expect(buildAdminResetWhere("shop.myshopify.com", [])).toBeNull();
    expect(buildAdminResetWhere("shop.myshopify.com", ["ownerConfig.pricing.marginCurves"])).toBeNull();
  });
});

// ---------- shop-scoped mutations (fake-db proofs) ----------

type Row = Record<string, any>;

function fakeModel(rows: Row[]) {
  let lastWhere: Record<string, unknown> | null = null;
  return {
    rows,
    get lastWhere() {
      return lastWhere;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      lastWhere = where;
      let count = 0;
      for (const row of rows) {
        if (row.id === where.id && row.shop === where.shop) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      lastWhere = where;
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].id === where.id && rows[index].shop === where.shop) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    },
  };
}

describe("shop-scoped mutations", () => {
  const SHOP_A = "a.myshopify.com";
  const SHOP_B = "b.myshopify.com";

  it("current-shop record can be modified (machines/materials pattern)", async () => {
    const model = fakeModel([{ id: "m1", shop: SHOP_A, active: true }]);
    const result = await updateOwnedRecord(model, SHOP_A, "m1", { active: false });
    expect(result).toEqual({ ok: true, count: 1 });
    expect(model.rows[0].active).toBe(false);
    expect(model.lastWhere).toEqual({ id: "m1", shop: SHOP_A });
  });

  it("another shop's record cannot be modified and fails closed with 404", async () => {
    const model = fakeModel([{ id: "m1", shop: SHOP_B, active: true }]);
    const result = await updateOwnedRecord(model, SHOP_A, "m1", { active: false });
    expect(result).toEqual({ ok: false, status: 404, error: "Record not found for this shop." });
    expect(model.rows[0].active).toBe(true);
  });

  it("unknown record fails closed with 404; missing shop/id fail closed with 400", async () => {
    const model = fakeModel([]);
    expect(await updateOwnedRecord(model, SHOP_A, "ghost", { active: false })).toMatchObject({ ok: false, status: 404 });
    expect(await updateOwnedRecord(model, "", "m1", { active: false })).toMatchObject({ ok: false, status: 400 });
    expect(await updateOwnedRecord(model, SHOP_A, "", { active: false })).toMatchObject({ ok: false, status: 400 });
    expect(await updateOwnedRecord(model, SHOP_A, Number.NaN, { active: false })).toMatchObject({ ok: false, status: 400 });
  });

  it("cross-shop delete is blocked; same-shop delete removes exactly the owned row (wholesale-rule pattern)", async () => {
    const model = fakeModel([
      { id: 7, shop: SHOP_A },
      { id: 7, shop: SHOP_B },
    ]);
    const blocked = await deleteOwnedRecord(model, SHOP_A, 99);
    expect(blocked).toMatchObject({ ok: false, status: 404 });

    const deleted = await deleteOwnedRecord(model, SHOP_A, 7);
    expect(deleted).toEqual({ ok: true, count: 1 });
    expect(model.rows).toEqual([{ id: 7, shop: SHOP_B }]);
    expect(model.lastWhere).toEqual({ id: 7, shop: SHOP_A });
  });
});

// ---------- repo source pins (route-level proofs without a route harness) ----------

describe("source pins — public proxy lockdown", () => {
  const configurator = readSource("app/routes/apps.wholesale-lite.configurator.ts");
  const checkout = readSource("app/routes/apps.wholesale-lite.configurator-checkout.ts");

  it("both configurator proxies require the signed Shopify app proxy", () => {
    expect(configurator).toContain("authenticate.public.appProxy");
    expect(checkout).toContain("authenticate.public.appProxy");
  });

  it("neither proxy sets wildcard CORS or trusts shop from request input", () => {
    expect(configurator.includes("Access-Control-Allow-Origin")).toBe(false);
    expect(checkout.includes("Access-Control-Allow-Origin")).toBe(false);
    expect(configurator.includes('searchParams.get("shop")')).toBe(false);
    expect(checkout.includes("body.shop")).toBe(false);
  });

  it("the public configurator payload no longer references internal cost/margin fields", () => {
    expect(configurator.includes("costEach")).toBe(false);
    expect(configurator.includes("totalProfit")).toBe(false);
    expect(configurator.includes("totalCost")).toBe(false);
    expect(configurator).toContain("stripInternalCostFields");
  });

  it("checkout never serializes stacks, raw Shopify payloads, or session-table tokens", () => {
    expect(checkout.includes("stack:")).toBe(false);
    expect(checkout.includes("raw: data")).toBe(false);
    expect(checkout.includes("details: draftRes")).toBe(false);
    expect(checkout.includes("db.session")).toBe(false);
    expect(checkout).toContain("sanitizeDraftOrderUserErrors");
    expect(checkout).toContain("publicCheckoutFailure");
  });
});

describe("source pins — loader side effects removed", () => {
  it("Machines loader performs no install/repair writes on GET", () => {
    const source = readSource("app/routes/app.erp.machines.tsx");
    const loaderSection = source.split("export async function loader")[1]?.split("export async function action")[0] || "";
    expect(loaderSection.includes("installGsoDefault")).toBe(false);
    expect(loaderSection.includes(".create(")).toBe(false);
    expect(loaderSection.includes(".update(")).toBe(false);
    expect(source).toContain("confirmPermanentDelete");
    expect(source).toContain("updateOwnedRecord");
  });

  it("Configurator admin loader can no longer delete/reseed pricing on page view", () => {
    const source = readSource("app/routes/app.erp.configurator.tsx");
    expect(source.includes("ensureStockPilotData")).toBe(false);
    expect(source).toContain("RESET_PILOT_DATA_PHRASE");
    expect(source).toMatch(/\$transaction\(\[\s*db\.configuratorPricingRule\.deleteMany/);
  });
});

describe("source pins — owner confirmation gates", () => {
  it("Margin Review live price push requires the owner phrase", () => {
    const source = readSource("app/routes/app.erp.margin-review.tsx");
    expect(source).toContain("OWNER_SHOPIFY_PRICE_PUSH_PHRASE");
    expect(source).toContain("pushConfirmPhrase");
    expect(source).toContain("MARGIN_REVIEW_PUSH_WARNING");
  });

  it("Admin Settings reset is phrase-gated and never issues a bare shop-wide delete", () => {
    const source = readSource("app/routes/app.erp.admin-settings.tsx");
    expect(source).toContain("OWNER_RESET_SETTINGS_PHRASE");
    expect(source).toContain("buildAdminResetWhere");
    expect(source.includes("deleteMany({ where: { shop } })")).toBe(false);
  });
});

describe("source pins — scoped writes and transactions", () => {
  it("wholesale rule mutations are shop-scoped", () => {
    const lib = readSource("app/lib/wholesale.server.ts");
    expect(lib).toContain("deleteMany({ where: { id, shop } })");
    expect(lib).toMatch(/updateMany\(\{\s*where: \{ id, shop \}/);
    const route = readSource("app/routes/app.wholesale.rules.tsx");
    expect(route).toContain("deleteRule(session.shop");
  });

  it("configurator audit loader authenticates and scopes reads to the shop", () => {
    const source = readSource("app/routes/app.erp.configurator-audit.tsx");
    expect(source).toContain("authenticate.admin(request)");
    expect(source.match(/shop,\s*\n/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("recipe permanent delete and pricing-rule replacement run in transactions", () => {
    const productSetup = readSource("app/routes/app.erp.product-setup.tsx");
    const deleteSection = productSetup.split('intent === "deleteRecipeForever"')[1]?.split("searchShopifyProductsForRecipe")[0] || "";
    expect(deleteSection).toContain("$transaction");
    const pricingRules = readSource("app/routes/app.erp.pricing-rules.tsx");
    expect(pricingRules).toMatch(/\$transaction\(\[\s*db\.pricingRule\.deleteMany/);
  });
});

describe("source pins — secret hygiene", () => {
  it("repo .gitignore excludes the live Roland sync config and tool backups", () => {
    const gitignore = readSource(".gitignore");
    expect(gitignore).toContain("tools/gso-roland-sync.config.json");
    expect(gitignore).toContain("tools/gso-roland-sync-config.json");
    expect(gitignore).toContain("tools/*.bak");
  });

  it("the tracked Roland example config holds only a placeholder token", () => {
    const example = readSource("tools/gso-roland-sync-config.example.json");
    expect(example).toContain("PASTE_TOKEN_FROM_PRINT_INTAKE_PAGE");
    expect(example.includes("gso_plog_")).toBe(false);
  });
});
