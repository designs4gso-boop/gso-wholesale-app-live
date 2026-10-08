// Setup pages + Reports Dashboard UX pass (2026-10-05).
//
// Display/copy-only pass over Material Center, Machine Center, Vendor Center,
// Vendor Cost Book and the Reports Dashboard. These tests pin, by reading the
// route sources, that:
//   1. every form field name / fetcher payload key / action intent that existed
//      BEFORE the pass is still present (no server contract drift),
//   2. no visible page title / h1 / h2 carries a patch label or patch code,
//   3. the new badge / empty-state / unit strings exist.
// No Prisma, no Shopify, no route imports — source pins only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES = {
  materials: "app/routes/app.erp.materials.tsx",
  machines: "app/routes/app.erp.machines.tsx",
  vendors: "app/routes/app.erp.vendors.tsx",
  costBook: "app/routes/app.erp.vendor-cost-book.tsx",
  reports: "app/routes/app.erp.reports-dashboard.tsx",
} as const;

const source = Object.fromEntries(
  Object.entries(ROUTES).map(([key, path]) => [key, readFileSync(path, "utf8").replace(/\r\n/g, "\n")]),
) as Record<keyof typeof ROUTES, string>;

function expectAll(text: string, needles: string[]) {
  for (const needle of needles) expect(text, `missing: ${needle}`).toContain(needle);
}

// Fetcher JSON payload keys (materials / machines submit JSON, not FormData).
function expectPayloadKeys(text: string, keys: string[]) {
  for (const key of keys) {
    expect(new RegExp(`\\b${key}\\s*[,:}]`).test(text), `payload key missing: ${key}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 1. Server contracts pinned (captured before the UX edit)
// ---------------------------------------------------------------------------
describe("materials: field names + intents unchanged", () => {
  it("keeps every action intent", () => {
    expectAll(source.materials, [
      'intent === "saveMaterial"',
      'intent === "addMaterialVariant"',
      'intent === "archiveMaterialVariant"',
      'intent === "restoreMaterialVariant"',
      'intent === "deleteMaterial"',
      'intent === "archiveMaterial"',
      'intent === "restoreMaterial"',
      'intent === "permanentDeleteMaterial"',
      'intent === "addVendor"',
      'intent: "saveMaterial"',
      'intent: "addMaterialVariant"',
      'intent: "archiveMaterialVariant"',
      'intent: "restoreMaterialVariant"',
      'intent: "archiveMaterial"',
      'intent: "restoreMaterial"',
      'intent: "permanentDeleteMaterial"',
      'intent: "addVendor"',
    ]);
  });

  it("keeps every fetcher payload key", () => {
    expectPayloadKeys(source.materials, [
      "id", "name", "materialType", "productFamilies", "vendor", "primaryVendorId", "sku", "stockOnHand",
      "reorderPoint", "leadTimeDays", "reason", "notes", "costReviewNeeded", "useInRecipes", "purchaseUnit",
      "purchaseCost", "baseUnit", "rollWidthIn", "rollLengthFt", "volumeMl", "caseQuantity",
      "materialId", "vendorCenterId", "vendorName", "vendorSku", "unitCost", "moq",
      "variantName", "color", "variantSku", "variantStockOnHand", "variantReorderPoint", "variantNotes", "variantId",
    ]);
  });
});

describe("machines: field names + intents unchanged", () => {
  it("keeps every action intent", () => {
    for (const intent of ["saveMachine", "deleteMachine", "restoreMachine", "permanentDeleteMachine", "updateSlot", "clearSlot", "installGsoDefaults"]) {
      expect(source.machines).toContain(`intent === "${intent}"`);
      expect(source.machines).toContain(`intent: "${intent}"`);
    }
  });

  it("keeps every fetcher payload key", () => {
    expectPayloadKeys(source.machines, [
      "id", "name", "machineType", "maxWidthIn", "costPerHour", "sqftPerHour", "setupWastePct", "allowOverflow",
      "confirmPermanentDelete", "inkName", "inkType", "cartridgeCost", "cartridgeMl", "mlPerSqft1Pct", "overwriteExisting",
    ]);
  });
});

describe("vendors: form field names + intents unchanged", () => {
  it("keeps every <input name>", () => {
    for (const name of [
      "active", "address1", "city", "contactEmail", "contactName", "contactPhone", "email", "id", "intent", "leadTimeDays",
      "moqNotes", "name", "notes", "paymentTerms", "phone", "primary", "qualityNotes", "role", "shippingNotes", "state",
      "status", "vendorId", "vendorType", "website", "zip",
    ]) expect(source.vendors, `field missing: ${name}`).toContain(`name="${name}"`);
  });

  it("keeps every intent value", () => {
    for (const intent of ["seedFromExisting", "createVendor", "updateVendor", "toggleVendorActive", "addContact"]) {
      expect(source.vendors).toContain(`value="${intent}"`);
      expect(source.vendors).toContain(`intent === "${intent}"`);
    }
  });
});

describe("vendor cost book: form field names + intents unchanged", () => {
  it("keeps every <input name>", () => {
    for (const name of [
      "confirmDuplicate", "costBookItemId", "effectiveDate", "expiresAt", "id", "intent", "itemName", "itemType", "leadTimeDays",
      "materialId", "maxQty", "minQty", "moq", "notes", "preferred", "status", "tierNotes", "tierUnitCost", "unit", "unitCost",
      "vendorId", "vendorName", "vendorProductId", "vendorSku",
    ]) expect(source.costBook, `field missing: ${name}`).toContain(`name="${name}"`);
  });

  it("keeps every intent value and option value", () => {
    for (const intent of ["createCostItem", "updateCostItem", "addTier", "deleteTier", "archiveCostItem", "applyToMaterial", "applyToVendorProduct", "seedFromMaterials", "seedFromVendorProducts"]) {
      expect(source.costBook).toContain(`value="${intent}"`);
      expect(source.costBook).toContain(`intent === "${intent}"`);
    }
    for (const option of ["material", "vendor_product", "sourced_product", "service", "other", "active", "draft", "expired", "inactive", "true", "false", "1"]) {
      expect(source.costBook, `option value missing: ${option}`).toContain(`value="${option}"`);
    }
  });
});

describe("reports dashboard: form field names + intents unchanged", () => {
  it("keeps every filter / form field name", () => {
    for (const name of ["decision", "decisionNote", "intent", "ractor", "range", "rbelow", "rcustomer", "rfamily", "rreopened", "rvariance", "rwarnings", "suggestionId"]) {
      expect(source.reports, `field missing: ${name}`).toContain(`name="${name}"`);
    }
    for (const value of ["reviewPricingFeedback", "7", "30", "90", "365", "all", "pos", "neg", "1"]) {
      expect(source.reports, `value missing: ${value}`).toContain(`value="${value}"`);
    }
    expect(source.reports).toContain('!== "reviewPricingFeedback"');
    for (const kind of ["jobs", "families", "products", "vendors", "feedback"]) expect(source.reports).toContain(`"${kind}"`);
  });

  it("does not add queries: loader still has the same db calls", () => {
    const loader = source.reports.slice(source.reports.indexOf("export async function loader"), source.reports.indexOf("function MetricCard"));
    const dbCalls = loader.match(/db\.[a-zA-Z]+\.(findMany|count|findFirst)/g) || [];
    // 3 finalized-report calls + 7 in the Promise.all + 2 in the read-only name audit.
    expect(dbCalls.length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 2. No patch labels / codes in visible headings
// ---------------------------------------------------------------------------
describe("no patch numbers in page titles or h1/h2 headings", () => {
  const PATCH_WORD = /Patch /;
  const PATCH_CODE = /\b1[0-9][A-Z]/;

  function headings(text: string) {
    const found: string[] = [];
    for (const re of [
      /<h1[^>]*>([\s\S]*?)<\/h1>/g,
      /<h2[^>]*>([\s\S]*?)<\/h2>/g,
      /<Text as="h2"[^>]*>([\s\S]*?)<\/Text>/g,
      /\btitle="([^"]*)"/g,
      /<Section title="([^"]*)"/g,
    ]) {
      for (const match of text.matchAll(re)) found.push(match[1]);
    }
    return found;
  }

  for (const [key, text] of Object.entries(source)) {
    it(`${key}: headings are patch-free`, () => {
      const list = headings(text);
      expect(list.length).toBeGreaterThan(0);
      for (const heading of list) {
        expect(heading, `patch label in heading: ${heading}`).not.toMatch(PATCH_WORD);
        expect(heading, `patch code in heading: ${heading}`).not.toMatch(PATCH_CODE);
      }
    });
  }

  it("reports: visible copy no longer says 'not built in this patch'", () => {
    expect(source.reports).not.toContain("not built in this patch");
  });
});

// ---------------------------------------------------------------------------
// 3. New badge / empty-state / unit strings exist
// ---------------------------------------------------------------------------
describe("materials: new display strings", () => {
  it("badges, units, empty states, destructive labels", () => {
    expectAll(source.materials, [
      'tone="critical">Cost missing',
      'tone="warning">Cost needs review',
      'tone="critical">Vendor not set',
      'tone="critical">Low stock',
      "<Badge>Inactive</Badge>",
      "No materials yet.",
      "No materials match these filters.",
      "Stock: not recorded",
      "Alternate vendor prices",
      "Cost history (last ",
      "Delete permanently",
      "Archive (hide, keeps history)",
      "Purchase cost ($ per ${purchaseUnit})",
      'label="Roll width (in)"',
      'label="Roll length (ft)"',
      "Vendor name (only if not in Vendor Center)",
      "Primary vendor (Vendor Center)",
      "Alternate vendor pricing",
    ]);
    // "$x per unit" formatting helper is used for the card cost line.
    expect(source.materials).toMatch(/per \$\{formatBaseUnitLabel\(unit\)\}/);
    // Green is reserved for verified data; no model field verifies a material, so no success badges.
    expect(source.materials).not.toContain('tone="success"');
  });
});

describe("machines: new display strings", () => {
  it("badges, units, empty states, destructive labels", () => {
    expectAll(source.machines, [
      'tone="critical">Hourly rate missing',
      'tone="warning">Default values (estimated)',
      'tone="critical">Ink cost missing',
      'tone="warning">Default cost (estimated)',
      "<Badge>Empty slot</Badge>",
      'tone="info">Accepts overflow',
      "No machines yet.",
      "No ink slots recorded for this machine.",
      "Machine cost ($ per hour)",
      "Throughput (sqft per hour)",
      "Max print width (in)",
      "Cartridge / bottle cost ($)",
      "Cartridge / bottle size (ml)",
      "Ink use (ml per sqft at 1% coverage)",
      "per ml",
      "Reset defaults (overwrites edits)",
      "Delete permanently (with ink slots)",
      "Clear slot (erase ink and cost)",
      "Archive machine (hide, keeps slots)",
    ]);
    expect(source.machines).not.toContain('tone="success"');
    // Clear slot is destructive and now asks first.
    expect(source.machines).toMatch(/function clearSlot[\s\S]*?confirm\(/);
  });
});

describe("vendors: new display strings", () => {
  it("badges, empty states, destructive labels", () => {
    expectAll(source.vendors, [
      'tone="warning">Seeded — review details',
      'tone="critical">{`Missing: ${missing.join(", ")}`}',
      'tone="critical">Vendor record missing',
      "No vendor records yet.",
      "No additional contacts yet.",
      "Archive vendor (hide, keeps history)",
      "Restore vendor",
      'label="Lead time (days)"',
      "Main contact name",
      "Vendors overview",
      "not set",
      "not recorded",
    ]);
    expect(source.vendors).not.toContain("TBD");
    expect(source.vendors).not.toContain('tone="success">');
  });
});

describe("vendor cost book: new display strings", () => {
  it("badges, units, empty states, destructive labels", () => {
    expectAll(source.costBook, [
      'tone="critical">Vendor missing',
      'tone="critical">Cost missing',
      'tone="critical">{`Expired${',
      'tone="warning">Seeded — confirm with vendor quote',
      "No vendor cost items yet.",
      "No price breaks yet.",
      "Delete price break",
      "Archive item (hide, keeps history)",
      "Unit cost ($ per unit)",
      "Tier cost ($ per unit)",
      "Minimum order qty (MOQ)",
      "Vendor name (only if not in Vendor Center)",
      "Tier cost at MOQ",
      " and up",
    ]);
    expect(source.costBook).toMatch(/money\(value\)\} per \$\{unit/);
    expect(source.costBook).not.toContain('tone="success">');
    // Tier delete is irreversible and now asks first.
    expect(source.costBook).toMatch(/deleteTier[\s\S]{0,400}Delete price break/);
    expect(source.costBook).toMatch(/window\.confirm\(`Delete the/);
  });
});

describe("reports dashboard: not-recorded handling + headings", () => {
  it("renders missing data as not recorded, never a confirmed zero", () => {
    expectAll(source.reports, [
      'const NOT_RECORDED = "not recorded"',
      "hasFinalized ? money(report.exec.revenue) : NOT_RECORDED",
      "hasPrintLogs ?",
      "hasStockValue ?",
      "hasQuotes ?",
      "hasJobs ?",
      'row.variancePct == null ? NOT_RECORDED',
      'return "not recorded"',
      "No finalized jobs in this range",
      "No quotes created in this range.",
      "No active jobs.",
      "Not reported here yet (no data source)",
    ]);
    expect(source.reports).not.toContain('"unavailable" : pct');
  });

  it("surfaces already-loaded data and plain-language headings", () => {
    expectAll(source.reports, [
      "data.quoteStatusCounts",
      "counts.followUpPurchases",
      "counts.vendors",
      "counts.costBookItems",
      "Actual profitability (finalized jobs only)",
      "Sales and pipeline",
      "Active production (estimates, not finalized)",
      'Section title="Jobs needing attention"',
      'Section title="Quotes by status"',
      "Data cleanup: product name check (read-only)",
      "Finalized by (name contains)",
    ]);
    // Header nesting fix: the finalized section is a sibling of the header row, not inside the <h1> wrapper.
    const h1Index = source.reports.indexOf("<h1");
    const headerClose = source.reports.indexOf("</form>\n      </div>", h1Index);
    const reportSection = source.reports.indexOf("{report ? (");
    expect(headerClose).toBeGreaterThan(h1Index);
    expect(reportSection).toBeGreaterThan(headerClose);
  });
});
