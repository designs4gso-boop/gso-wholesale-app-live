import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_FAMILY_REGISTRY,
  calculatorFamilies,
  calculatorFamilyValues,
  deriveProductVerification,
  familyByKeyOrAlias,
  findLikelyDuplicates,
  normalizeProductKey,
  productSetupFamilyLabels,
  productSpecToken,
} from "../app/lib/product-family-registry";
import { LEGACY_CONFLICTING_RATES, OWNER_STANDARDS } from "../app/lib/owner-standards";
import { OWNER_LABOR, resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { WIRED_LABOR } from "../app/lib/cost-calculator.server";
import { PRODUCT_FAMILY_SALES_RULES } from "../app/lib/product-family-sales-rules";
import { bagApplicationRateFor, canonicalUiFamily, marginFamilyKeyFor } from "../app/lib/product-driven-costing.server";

describe("product-family registry (15B)", () => {
  it("holds the six canonical calculator families plus the RESERVED dtp-bags entry, with unique keys and labels", () => {
    const keys = PRODUCT_FAMILY_REGISTRY.map((entry) => entry.key);
    expect(keys).toEqual(["sticker-bags", "standard-jars", "premium-jars", "stickers-labels", "banners", "custom-item", "dtp-bags"]);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
    const visibleLabels = calculatorFamilies().map((entry) => entry.label);
    expect(new Set(visibleLabels).size).toBe(visibleLabels.length); // no duplicate visible families
  });

  it("resolves every legacy alias to its canonical family; canonicalUiFamily is registry-driven", () => {
    expect(familyByKeyOrAlias("bags-4x5")!.key).toBe("sticker-bags");
    expect(familyByKeyOrAlias("chiron-jars")!.key).toBe("premium-jars");
    expect(familyByKeyOrAlias("miron-jars")!.key).toBe("premium-jars");
    expect(familyByKeyOrAlias("custom")!.key).toBe("custom-item");
    expect(familyByKeyOrAlias("dtp-pouches")!.key).toBe("dtp-bags");
    expect(familyByKeyOrAlias("nonsense")).toBeNull();
    // engine canonicalization matches the registry (unchanged behavior for the live six)
    expect(canonicalUiFamily("bags-4x5")).toBe("sticker-bags");
    expect(canonicalUiFamily("chiron-jars")).toBe("premium-jars");
    expect(canonicalUiFamily("custom")).toBe("custom-item");
    expect(canonicalUiFamily("unknown-thing")).toBe("custom-item");
  });

  it("DTP stays hidden until Phase 15C: registered but never exposed to the live calculator", () => {
    const dtp = familyByKeyOrAlias("dtp-bags")!;
    expect(dtp.calculatorEnabled).toBe(false); // reserved
    expect(dtp.marginRuleKey).toBe("dtp-pouches");
    expect(calculatorFamilies().some((entry) => entry.key === "dtp-bags")).toBe(false);
    expect(calculatorFamilyValues()).not.toContain("dtp-bags");
    expect(calculatorFamilyValues()).not.toContain("dtp-pouches");
    // the live six (plus their aliases) are ALL still accepted
    for (const value of ["sticker-bags", "bags-4x5", "standard-jars", "premium-jars", "chiron-jars", "miron-jars", "stickers-labels", "banners", "custom", "custom-item"]) {
      expect(calculatorFamilyValues()).toContain(value);
    }
  });

  it("margin and sales mappings stay correct: registry keys resolve in their owner-approved tables", () => {
    for (const entry of PRODUCT_FAMILY_REGISTRY) {
      if (entry.marginRuleKey) expect(resolveMarginFamily(entry.marginRuleKey), `${entry.key} margin`).not.toBeNull();
      if (entry.salesRuleKey) expect(PRODUCT_FAMILY_SALES_RULES.some((rule) => rule.key === entry.salesRuleKey), `${entry.key} sales`).toBe(true);
    }
    // class/size-dependent margin resolution is unchanged (executable truth)
    expect(marginFamilyKeyFor("sticker-bags", "bag_sticker", "4x5 Blank Bag")).toBe("bags-4x5");
    expect(marginFamilyKeyFor("premium-jars", "jar_chiron", "Chiron 100 ml")).toBe("chiron-jars");
    expect(marginFamilyKeyFor("premium-jars", "jar_miron", "150ml Miron jar + lid")).toBe("miron-jars");
    expect(marginFamilyKeyFor("standard-jars", "jar_standard", "3oz jar - clear")).toBeNull(); // provisional, labeled
  });

  it("Product Setup vocabulary is registry-first and keeps every legacy recipe-family string", () => {
    const labels = productSetupFamilyLabels();
    expect(labels[0]).toBe("Sticker Bags"); // registry order first
    for (const label of ["Jars", "Labels / Stickers", "Banners", "Custom / Other", "DTP Pouches"]) expect(labels).toContain(label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("owner standards (15B)", () => {
  it("resolves the owner-authoritative values", () => {
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.value).toBeCloseTo(20 / 256, 10); // $0.078125 = $20/hr at 256 labels/hr
    expect(OWNER_STANDARDS.bagApplicationPerLabel4x5.value).toBeCloseTo(0.078125, 10);
    expect(OWNER_STANDARDS.jarApplicationPerLabel.value).toBeCloseTo(0.2, 10);
    expect(OWNER_STANDARDS.artSetupPerDesign.value).toBeCloseTo(25 / 3, 10);
    expect(OWNER_STANDARDS.printSetupPerDesign.value).toBeCloseTo(1.0, 10);
    expect(OWNER_STANDARDS.weedingPerPage54x54.value).toBeCloseTo(20 / 15, 10);
    expect(OWNER_STANDARDS.packoutPerBox.value).toBeCloseTo(2.0, 10);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(8);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.status).toBe("provisional");
  });

  it("calculator OWNER_LABOR is wired to the shared standards (one source, same numbers)", () => {
    expect(OWNER_LABOR.bagLabelApplicationPer).toBe(OWNER_STANDARDS.bagApplicationPerLabel4x5.value);
    expect(OWNER_LABOR.jarApplicationPer).toBe(OWNER_STANDARDS.jarApplicationPerLabel.value);
    expect(OWNER_LABOR.artSetupPerDesign).toBe(OWNER_STANDARDS.artSetupPerDesign.value);
    expect(OWNER_LABOR.printSetupPerDesign).toBe(OWNER_STANDARDS.printSetupPerDesign.value);
    expect(OWNER_LABOR.weedingPerPage54x54).toBe(OWNER_STANDARDS.weedingPerPage54x54.value);
    expect(OWNER_LABOR.packoutPerBox).toBe(OWNER_STANDARDS.packoutPerBox.value);
  });

  it("legacy conflicting rates are quarantined and CANNOT override calculator truth", () => {
    // the legacy $0.1111 4x5 rate still exists (legacy calculator fallback only)…
    expect(WIRED_LABOR.bag4x5PerSide).toBeCloseTo(20 / 180, 10);
    expect(LEGACY_CONFLICTING_RATES.bag4x5PerSideLegacy.value).toBeCloseTo(WIRED_LABOR.bag4x5PerSide, 10);
    // …but the product engine resolves 4x5 application from the OWNER standard
    expect(WIRED_LABOR.bag4x5PerSide).not.toBeCloseTo(OWNER_STANDARDS.bagApplicationPerLabel4x5.value, 6);
    expect(bagApplicationRateFor("4x5 Blank Bag").rate).toBeCloseTo(OWNER_STANDARDS.bagApplicationPerLabel4x5.value, 10);
    expect(bagApplicationRateFor("14x16 Blank Bag").rate).toBeCloseTo(OWNER_STANDARDS.bagApplicationPerLabel14x16.value, 10);
    // machine recovery: the current standard is $8, superseding the legacy $25 figure
    expect(LEGACY_CONFLICTING_RATES.marginReviewLaborPerHour.value).toBe(25);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).not.toBe(LEGACY_CONFLICTING_RATES.marginReviewLaborPerHour.value);
  });
});

describe("product status + duplicate prevention (15B)", () => {
  it("derives Draft / Unverified / Verified with Active / Inactive from existing data (no schema change)", () => {
    expect(deriveProductVerification({ active: true, unitCost: 1.8, tierCount: 0, costBookStatus: "active" }))
      .toEqual({ lifecycle: "Active", verification: "Verified", basis: "Vendor Cost Book review (status active)" });
    const implicit = deriveProductVerification({ active: true, unitCost: 0.09, tierCount: 0 });
    expect(implicit.verification).toBe("Verified");
    expect(implicit.basis).toContain("implicit"); // cost>0 alone is labeled, not silently equal to reviewed
    expect(deriveProductVerification({ active: true, unitCost: 0, tierCount: 0, costBookStatus: "pending" }).verification).toBe("Unverified");
    expect(deriveProductVerification({ active: true, unitCost: 0, tierCount: 0 }).verification).toBe("Draft");
    expect(deriveProductVerification({ active: false, unitCost: 3.26, tierCount: 5 }).lifecycle).toBe("Inactive");
    expect(deriveProductVerification({ active: true, unitCost: 0, tierCount: 5 }).verification).toBe("Verified"); // tiered records count as priced
  });

  it("flags likely duplicates by sku, normalized name, and vendor+size/spec — never silently merges", () => {
    const existing = [
      { id: "1", name: "4x5 Blank Bag", vendor: "Vendor TBD", vendorSku: "preset:blank-4x5-bag" },
      { id: "2", name: "Chiron 100 ml", vendor: "CHIRON", vendorSku: "chiron-100ml" },
    ];
    expect(findLikelyDuplicates({ name: "Totally new", vendorSku: "preset:blank-4x5-bag" }, existing)).toHaveLength(1); // sku match
    expect(findLikelyDuplicates({ name: "4X5  blank BAG" }, existing)).toHaveLength(1); // normalized-name match
    expect(findLikelyDuplicates({ name: "Chiron jar 100ml round", vendor: "Chiron" }, existing)).toHaveLength(1); // vendor + spec token
    expect(findLikelyDuplicates({ name: "Chiron 150 ml", vendor: "CHIRON" }, existing)).toHaveLength(0); // different spec — allowed
    expect(findLikelyDuplicates({ name: "5x8 Sticker Bag" }, existing)).toHaveLength(0);
    expect(normalizeProductKey("SAFE CARE")).toBe("safecare");
    expect(productSpecToken("DTP 4x5x2 Blank Pouch")).toBe("4x5x2");
    expect(productSpecToken("Chiron 100 ml")).toBe("100ml");
  });
});

describe("15B wiring pins", () => {
  const setupSrc = readFileSync(new URL("../app/routes/app.erp.product-setup.tsx", import.meta.url), "utf8");
  const newSrc = readFileSync(new URL("../app/routes/app.erp.products.new.tsx", import.meta.url), "utf8");
  const bookSrc = readFileSync(new URL("../app/routes/app.erp.vendor-cost-book.tsx", import.meta.url), "utf8");
  const calcSrc = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");

  it("Product Setup is the product home: registry vocabulary + grouped sections + derived status + Cost Book links", () => {
    expect(setupSrc).toContain("productSetupFamilyLabels()");
    expect(setupSrc).toContain("deriveProductVerification");
    expect(setupSrc).toContain('id="basics"');
    expect(setupSrc).toContain('id="vendor-cost"');
    expect(setupSrc).toContain('id="calculator-rules"');
    expect(setupSrc).toContain('id="production-recipe"');
    expect(setupSrc).toContain("/app/erp/vendor-cost-book"); // navigation to the single cost store
    expect(setupSrc).toContain("+ New Product (guided wizard)");
  });

  it("Add Product remains the guided front door that routes INTO Product Setup", () => {
    expect(newSrc).toContain("redirect(`/app/erp/product-setup?recipeStatus=archived&recipeId=${recipe.id}`)");
    expect(newSrc).toContain("findLikelyDuplicates");
    expect(newSrc).toContain("confirmDuplicate");
    expect(newSrc).toContain("Nothing was created or merged");
  });

  it("Vendor Cost Book stays the ONLY cost store and warns before duplicate cost items", () => {
    expect(bookSrc).toContain("findLikelyDuplicates");
    expect(bookSrc).toContain("confirmDuplicate");
    expect(bookSrc).toContain('intent === "applyToVendorProduct"'); // apply flow unchanged
  });

  it("calculator machine rate resolves from the shared owner standards", () => {
    expect(calcSrc).toContain("machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value");
    expect(calcSrc).not.toContain("machineRatePerHour: 8,");
  });
});
