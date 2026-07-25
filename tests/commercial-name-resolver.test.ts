import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  cleanCommercialName,
  isPlaceholderName,
  resolveProductDisplayName,
  resolveQuoteDisplayName,
  safeNameToken,
} from "../app/lib/commercial-name-resolver.server";
import { suggestedFileNameForQuoteItem } from "../app/lib/production-job-source.server";

describe("commercial name resolver (15D.2)", () => {
  it("treats the documented placeholders as invalid names", () => {
    for (const placeholder of ["", "Not selected / unknown", "Not selected", "Unknown", "N/A", "No product selected", "  unknown  ", "not SELECTED / UNKNOWN"]) {
      expect(isPlaceholderName(placeholder), JSON.stringify(placeholder)).toBe(true);
      expect(cleanCommercialName(placeholder)).toBeNull();
    }
    expect(isPlaceholderName("Production Test Sticker")).toBe(false);
  });

  it("repairs the live-tested corruption: 'NoProduction Test Sticker selected / unknown' -> 'Production Test Sticker'", () => {
    expect(cleanCommercialName("NoProduction Test Sticker selected / unknown")).toBe("Production Test Sticker");
    expect(cleanCommercialName("Production Test Sticker")).toBe("Production Test Sticker");
    expect(cleanCommercialName("  Production   Test  Sticker  ")).toBe("Production Test Sticker");
    // never strips "No…" from legitimate names (no placeholder fragment present)
    expect(cleanCommercialName("NoBull Sticker Co")).toBe("NoBull Sticker Co");
    expect(cleanCommercialName("Northern Lights Banner")).toBe("Northern Lights Banner");
    // never CONCATENATES placeholders with valid names
    expect(cleanCommercialName("Production Test Sticker Not selected / unknown")).toBe("Production Test Sticker");
    expect(cleanCommercialName("No product selected")).toBeNull();
  });

  it("resolves display names by the authoritative precedence with the Custom Quote fallback", () => {
    expect(resolveProductDisplayName(["Production Test Sticker", "Spektra DTP 4x5x2"])).toBe("Production Test Sticker");
    expect(resolveProductDisplayName(["Not selected / unknown", "Spektra DTP 4x5x2"])).toBe("Spektra DTP 4x5x2"); // placeholder skipped
    expect(resolveProductDisplayName(["", null, undefined, "Sticker Bags"])).toBe("Sticker Bags"); // family label fallback
    expect(resolveProductDisplayName(["", "Unknown", null])).toBe("Custom Quote"); // safe fallback
  });

  it("quote display names: customer + product, product-only, customer-only, fallback", () => {
    expect(resolveQuoteDisplayName({ company: "JarCo", productName: "Production Test Sticker" })).toBe("JarCo — Production Test Sticker");
    expect(resolveQuoteDisplayName({ customerName: "", productName: "Production Test Sticker" })).toBe("Production Test Sticker"); // no "Unnamed Quote"
    expect(resolveQuoteDisplayName({ customerName: "Jane Doe" })).toBe("Jane Doe");
    expect(resolveQuoteDisplayName({ customerName: "Unknown", productName: "N/A" })).toBe("Custom Quote");
    expect(resolveQuoteDisplayName({ customerName: "Jane", productName: "NoProduction Test Sticker selected / unknown" })).toBe("Jane — Production Test Sticker");
  });

  it("safe tokens: uppercase, placeholder-free, dimension-preserving, never blank", () => {
    expect(safeNameToken("Production Test Sticker")).toBe("PRODUCTION-TEST-STICKER");
    expect(safeNameToken("NoProduction Test Sticker selected / unknown")).toBe("PRODUCTION-TEST-STICKER");
    expect(safeNameToken("Spektra DTP 4x5x2")).toBe("SPEKTRA-DTP-4X5X2"); // dimensions preserved
    expect(safeNameToken("150ml Miron jar + lid")).toBe("150ML-MIRON-JAR-LID");
    expect(safeNameToken("Not selected / unknown")).toBe("ITEM"); // never blank
    expect(safeNameToken("", "PRODUCT")).toBe("PRODUCT");
    expect(safeNameToken("A".repeat(100)).length).toBeLessThanOrEqual(40); // capped without touching ticket IDs (tickets are prefixed separately)
  });

  it("production filenames carry the clean token and the untouched ticket ID", () => {
    const corrupted = { productName: "NoProduction Test Sticker selected / unknown", variant: null, quantity: 250 };
    expect(suggestedFileNameForQuoteItem("GSO-20260724-0007", corrupted, 0))
      .toBe("GSO-20260724-0007-01_PRODUCTION-TEST-STICKER_VARIANT_QTY250");
    const clean = { productName: "Production Test Sticker", variant: "Matte", quantity: 250 };
    expect(suggestedFileNameForQuoteItem("GSO-20260724-0007", clean, 1))
      .toBe("GSO-20260724-0007-02_PRODUCTION-TEST-STICKER_MATTE_QTY250");
  });
});

describe("naming wiring pins (15D.2)", () => {
  const calcSrc = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
  const quotesSrc = readFileSync(new URL("../app/routes/app.quotes.tsx", import.meta.url), "utf8");
  const serviceSrc = readFileSync(new URL("../app/lib/production-job-source.server.ts", import.meta.url), "utf8");

  it("calculator save resolves the product name via the shared precedence; the input never prefills with panel placeholders", () => {
    expect(calcSrc).toContain("resolveProductDisplayName([");
    expect(calcSrc).toContain("rawProductNameEntry");
    expect(calcSrc).toContain("savedBlankNameForNaming");
    expect(calcSrc).not.toContain('String(form.get("eproduct") || "Emergency calculator item")'); // old raw path gone
    expect(calcSrc).not.toContain('pm.productLabel || emergency.family?.label || "Selected product"'); // placeholder prefill gone
    expect(calcSrc).toContain('placeholder="e.g. Production Test Sticker"');
  });

  it("CRM shows the resolved display name (no 'Unnamed Quote' for new saves); Shopify line titles are cleaned; totals untouched", () => {
    expect(quotesSrc).not.toContain("Unnamed Quote");
    expect(quotesSrc).toContain("displayName: resolveQuoteDisplayName({");
    expect(quotesSrc).toContain("{quote.displayName || quote.company || quote.customerName ||");
    expect(quotesSrc).toContain('cleanCommercialName(item.productName) || "Custom print item"');
    expect(quotesSrc).toContain("Quote ID:"); // payment-webhook note matching unchanged
  });

  it("production service cleans item titles + quote-path filenames; Shopify-order naming stays verbatim for parity", () => {
    expect(serviceSrc).toContain('cleanCommercialName(item.productName) || "Custom item"');
    expect(serviceSrc).toContain('safeNameToken(item.productName || item.productTitle, "PRODUCT")');
    // webhook parity: order-item namer untouched (no resolver call inside it)
    const orderNamer = serviceSrc.slice(serviceSrc.indexOf("function suggestedFileNameForOrderItem"), serviceSrc.indexOf("// Pure builder"));
    expect(orderNamer).toContain("normalizeFilePart(item.productTitle || item.title");
    expect(orderNamer).not.toContain("safeNameToken");
  });
});
