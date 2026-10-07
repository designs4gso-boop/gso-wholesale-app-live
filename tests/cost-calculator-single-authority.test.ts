// Phase 11 (2026-10-04) — ONE authoritative calculation on the Cost Calculator.
//
// The canonical 17D.7 true cost is authoritative for canonical families; the
// legacy 14C.2 per-line engine remains as diagnostics only. The known control
// case (1000 x 3x3 matte, AUTO, CMYK) is pinned elsewhere at canonical
// 84.143290 (tests/canonical-quote-authority-2d4c1.test.ts,
// tests/label-form-canonical-2d4c2.test.ts) versus legacy 79.0818
// (tests/calculator-forensic-fixtures.test.ts) — they legitimately differ, and
// the UI must never present the legacy total as the job cost. This test pins
// the display contract in the route source; no formula was changed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../app/routes/app.erp.cost-calculator.tsx", import.meta.url), "utf8");
const component = src.slice(src.indexOf("function ProductBreakdown()"), src.indexOf("function ProductTiers()"));

describe("cost calculator — single authoritative calculation", () => {
  it("labels the legacy 14C.2 breakdown as diagnostics whenever a canonical result exists", () => {
    expect(component).toMatch(/const canonicalAuthoritative = Boolean\(canonical\) && !emergency\.productMode\?\.isDtp;/);
    expect(component).toMatch(/Legacy per-line diagnostics — NOT the job cost; the verified true cost above is authoritative/);
  });

  it("shows the canonical total as the job cost and the legacy total only as a comparison; a blocked canonical cost quotes nothing", () => {
    expect(component).toMatch(/Authoritative job cost \(canonical \{canonical\.version\}, \{canonical\.status\}\)/);
    expect(component).toMatch(/pricing tiers below are generated from the canonical cost/);
    expect(component).toMatch(/Legacy 14C\.2 diagnostic total .* is shown for comparison only and is never used for quoting/);
    expect(component).toMatch(/Canonical true cost is BLOCKED for this job — there is no authoritative job cost/);
    // the old unconditional sentence survives only in the non-canonical branch
    const legacySentence = component.match(/the automatic pricing tiers below are generated from these values/g) ?? [];
    expect(legacySentence.length).toBe(1);
    expect(component.indexOf("canonicalAuthoritative ? (")).toBeLessThan(component.indexOf("the automatic pricing tiers below are generated from these values"));
  });

  it("changes no math: the component still renders result.lines and derived values untouched", () => {
    expect(component).toMatch(/result\.lines\.filter\(\(line: any\) => line\.amount !== 0 \|\| line\.source === "missing"\)/);
    expect(component).not.toMatch(/canonical\.totalCost \*|result\.totalCost \*|toFixed\(2\) \+/);
  });
});
