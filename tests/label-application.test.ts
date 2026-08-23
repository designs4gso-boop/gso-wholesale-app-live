// Patch 2D (17D.5) — label application to a physical item.
//
// The point of these tests is QUANTITY SAFETY: 1,000 cans with 2 applications
// each must cost 1,000 cans and 2,000 applications, never 2,000 cans.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_LABOR_RATE_PER_HOUR,
  APPLICATION_REASONS,
  computeLabelApplication,
} from "../app/lib/label-application.server";

const amountOf = (r: ReturnType<typeof computeLabelApplication>, key: string) =>
  r.stages.find((s) => s.key === key)!.amount;

describe("1. NONE — labels only", () => {
  it("charges no item and no application labor", () => {
    const r = computeLabelApplication({ mode: "none", printedLabels: 5000 });
    expect(r.itemCost).toBe(0);
    expect(r.applicationLaborCost).toBe(0);
    expect(r.applicationEvents).toBe(0);
    expect(r.blockers).toHaveLength(0);
    expect(amountOf(r, "application_item")).toBe(0);
  });
});

describe("2. CUSTOMER_PROVIDED_ITEM", () => {
  const base = {
    mode: "customer_provided_item" as const,
    itemDescription: "soda can",
    itemQuantity: 1000,
    applicationsPerItem: 2,
    applicationSecondsPerEvent: 12,
    printedLabels: 2000,
  };

  it("1000 items x 2 = 2000 application events, item cost $0", () => {
    const r = computeLabelApplication(base);
    expect(r.physicalItems).toBe(1000);
    expect(r.applicationsPerItem).toBe(2);
    expect(r.applicationEvents).toBe(2000);
    expect(r.itemCost).toBe(0);
    expect(r.blockers).toHaveLength(0);
  });

  it("labor is charged on EVENTS, at the canonical $20/hr", () => {
    const r = computeLabelApplication(base);
    expect(APPLICATION_LABOR_RATE_PER_HOUR).toBe(20);
    expect(r.applicationLaborCost).toBeCloseTo((2000 * 12) / 3600 * 20, 10); // $133.33
    // ...and NOT on physical items
    expect(r.applicationLaborCost).not.toBeCloseTo((1000 * 12) / 3600 * 20, 6);
  });

  it("never prices the item, whatever a caller passes for unit cost", () => {
    const r = computeLabelApplication({ ...base, customItemUnitCost: 0.42 });
    expect(r.itemCost).toBe(0);
    expect(amountOf(r, "application_item")).toBe(0);
    expect(r.stages.find((s) => s.key === "application_item")!.note).toMatch(/customer supplies the item/i);
  });
});

describe("3. CUSTOM_ITEM", () => {
  const base = {
    mode: "custom_item" as const,
    itemDescription: "glass tube",
    itemQuantity: 1000,
    applicationsPerItem: 1,
    applicationSecondsPerEvent: 15,
    customItemUnitCost: 0.42,
    printedLabels: 1000,
  };

  it("1000 items at $0.42 = $420 item cost, PLUS application labor", () => {
    const r = computeLabelApplication(base);
    expect(r.itemCost).toBeCloseTo(420, 10);
    expect(r.applicationEvents).toBe(1000);
    expect(r.applicationLaborCost).toBeCloseTo((1000 * 15) / 3600 * 20, 10); // $83.33
    expect(r.blockers).toHaveLength(0);
  });

  it("item cost is charged on PHYSICAL ITEMS, not on application events", () => {
    const r = computeLabelApplication({ ...base, applicationsPerItem: 2, printedLabels: 2000 });
    expect(r.physicalItems).toBe(1000);
    expect(r.applicationEvents).toBe(2000);
    expect(r.itemCost).toBeCloseTo(1000 * 0.42, 10); // 1000 cans, NOT 2000
    expect(r.itemCost).not.toBeCloseTo(2000 * 0.42, 6);
  });

  it("a missing unit cost BLOCKS with CUSTOM_ITEM_COST_REQUIRED", () => {
    for (const bad of [undefined, null, Number.NaN, -1]) {
      const r = computeLabelApplication({ ...base, customItemUnitCost: bad as never });
      expect(r.reasons, String(bad)).toContain(APPLICATION_REASONS.customItemCostRequired);
      expect(r.itemCost).toBe(0);
      expect(r.stages.every((s) => s.amount === 0)).toBe(true);
    }
  });

  it("an explicit $0 unit cost is accepted — only MISSING blocks", () => {
    const r = computeLabelApplication({ ...base, customItemUnitCost: 0 });
    expect(r.reasons).not.toContain(APPLICATION_REASONS.customItemCostRequired);
    expect(r.itemCost).toBe(0);
    expect(r.applicationLaborCost).toBeGreaterThan(0);
  });
});

describe("4. blocking rules", () => {
  const base = {
    mode: "customer_provided_item" as const,
    itemQuantity: 1000,
    applicationsPerItem: 2,
    applicationSecondsPerEvent: 10,
    printedLabels: 2000,
  };

  it("applicationsPerItem of 0 is rejected", () => {
    const r = computeLabelApplication({ ...base, applicationsPerItem: 0 });
    expect(r.reasons).toContain(APPLICATION_REASONS.applicationsPerItemInvalid);
    expect(r.applicationLaborCost).toBe(0);
  });

  it("a fractional or negative applicationsPerItem is rejected", () => {
    for (const bad of [1.5, -2, Number.NaN]) {
      expect(computeLabelApplication({ ...base, applicationsPerItem: bad }).reasons)
        .toContain(APPLICATION_REASONS.applicationsPerItemInvalid);
    }
    // 4 applications on 1000 items needs 4000 labels, so supply them
    expect(computeLabelApplication({ ...base, applicationsPerItem: 4, printedLabels: 4000 }).blockers).toHaveLength(0);
  });

  it("a missing seconds-per-application BLOCKS with APPLICATION_RATE_REQUIRED", () => {
    for (const bad of [undefined, 0, -5]) {
      const r = computeLabelApplication({ ...base, applicationSecondsPerEvent: bad as never });
      expect(r.reasons, String(bad)).toContain(APPLICATION_REASONS.applicationRateRequired);
      expect(r.applicationLaborCost).toBe(0);
    }
  });

  it("1500 printed labels against 2000 required applications BLOCKS", () => {
    const r = computeLabelApplication({ ...base, printedLabels: 1500 });
    expect(r.reasons).toContain(APPLICATION_REASONS.labelQuantityShortfall);
    expect(r.blockers.join(" ")).toMatch(/1500 label\(s\) but 2000 application\(s\)/);
    expect(r.stages.every((s) => s.amount === 0)).toBe(true);
  });

  it("2500 printed labels against 2000 applications is ALLOWED — overage is fine", () => {
    const r = computeLabelApplication({ ...base, printedLabels: 2500 });
    expect(r.reasons).not.toContain(APPLICATION_REASONS.labelQuantityShortfall);
    expect(r.blockers).toHaveLength(0);
    expect(r.applicationLaborCost).toBeGreaterThan(0);
  });

  it("exact equality is allowed", () => {
    expect(computeLabelApplication({ ...base, printedLabels: 2000 }).blockers).toHaveLength(0);
  });

  it("a missing item quantity blocks", () => {
    const r = computeLabelApplication({ ...base, itemQuantity: 0 });
    expect(r.reasons).toContain(APPLICATION_REASONS.itemQuantityRequired);
  });
});

describe("5. diagnostics and architecture", () => {
  it("exposes the four counts separately so they can be displayed", () => {
    const r = computeLabelApplication({
      mode: "custom_item", itemDescription: "bottle", itemQuantity: 1000,
      applicationsPerItem: 2, applicationSecondsPerEvent: 9, customItemUnitCost: 1.25, printedLabels: 2100,
    });
    expect(r.physicalItems).toBe(1000);
    expect(r.applicationsPerItem).toBe(2);
    expect(r.applicationEvents).toBe(2000);
    expect(r.printedLabels).toBe(2100);
    expect(r.stages.find((s) => s.key === "application_labor")!.note)
      .toMatch(/APPLICATION EVENTS \(2000\), never on physical items \(1000\)/);
  });

  it("item cost posts to materials and labor to finishing — separate categories", () => {
    const r = computeLabelApplication({
      mode: "custom_item", itemQuantity: 10, applicationsPerItem: 1,
      applicationSecondsPerEvent: 10, customItemUnitCost: 1, printedLabels: 10,
    });
    expect(r.stages.find((s) => s.key === "application_item")!.category).toBe("materials");
    expect(r.stages.find((s) => s.key === "application_labor")!.category).toBe("finishing_application");
  });

  it("builds NO catalog and touches no database", () => {
    const src = readFileSync("app/lib/label-application.server.ts", "utf8");
    // check CODE, not prose — the comments deliberately SAY "no catalog"
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const t of ["prisma", "PrismaClient", "findMany", "ApplicationItem", "APPLICATION_ITEMS", "await "]) {
      expect(code.includes(t), t).toBe(false);
    }
    expect(src.match(/^import /gm)).toHaveLength(1); // the CostCategory type only
    // and no hard-coded item is named in CODE
    for (const item of ["soda can", "glass tube", "bottle"]) {
      expect(code.toLowerCase().includes(item), item).toBe(false);
    }
  });

  it("assumes no universal application time", () => {
    const src = readFileSync("app/lib/label-application.server.ts", "utf8");
    expect(src).toMatch(/universal application time for an arbitrary item does not exist/);
  });

  it("no live pricing path imports it", () => {
    for (const file of [
      "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/canonical-sticker-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts",
      "app/routes/apps.wholesale-lite.configurator.ts",
      "app/routes/apps.wholesale-lite.configurator-checkout.ts",
    ]) {
      expect(readFileSync(file, "utf8").includes("label-application"), file).toBe(false);
    }
  });
});
