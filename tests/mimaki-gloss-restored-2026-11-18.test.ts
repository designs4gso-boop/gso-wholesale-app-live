// 2026-11-18 (owner) — MIMAKI GLOSS IS RESTORED.
//   - Print Intake: gloss no longer decides the press. A CMYK + gloss pair
//     follows the CMYK rule (Mimaki unless explicitly Roland) and stays together.
//   - Layer suffixes: `_cmyk` / `_CMYK`, `_g` / `_G` / `_gloss` / `_GLOSS`
//     (white `_w` unchanged). Exact base-name pairing only.
//   - Mimaki clear / gloss ink has its own rate: $90 per 1000 ml landed = $0.09/ml.
//     It is added to CMYK, never priced at the CMYK or the Roland rate, and it
//     is not primer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRIMER_NOT_CONFIGURED,
  buildIntakeMachineContext,
  decideIntakeMachine,
  decideIntakeRoute,
  parseIntakeLayerTokens,
  type IntakeItem,
} from "../app/lib/print-intake-routing.server";
import { canonicalReviewReason } from "../app/lib/print-intake-review.server";
import { CANONICAL_INK_RATES, channelInkRatePerMl, normalizeInkChannelKind } from "../app/lib/ink-rates-shared";
import { buildBrandRates, computeEntryCosts } from "../app/lib/rip-actual-costs.server";
import { parseRasterlinkRows } from "../app/lib/rasterlink-parse.server";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const HASH = (char: string) => char.repeat(64);
function item(overrides: Partial<IntakeItem> = {}): IntakeItem {
  return { id: "item_1", itemTicket: "GSO-20261118-0001-01", ripJobName: "GSO-20261118-0001-01", suggestedFileName: null, productTitle: "Bag", selectedFinish: "CMYK", materialSummary: null, machineSummary: null, ...overrides };
}
const CMYK = "crud_HEATH_F_CMYK.pdf";
const G = "crud_HEATH_F_g.pdf";
const GLOSS = "crud_HEATH_F_GLOSS.pdf";
const pair = (a: string, b: string, base: Partial<IntakeItem> = {}) => [decideIntakeMachine(item(base), a, { relatedFileNames: [b] }), decideIntakeMachine(item(base), b, { relatedFileNames: [a] })];

describe("1-4, 8. routing: gloss follows CMYK to the Mimaki and the pair stays together", () => {
  it("CMYK only, no printer hint -> Mimaki", () => {
    expect(decideIntakeMachine(item())).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideIntakeMachine(item(), CMYK)).toMatchObject({ machine: "mimaki" });
  });
  it("CMYK + _g exact sibling pair -> both Mimaki", () => {
    const [c, g] = pair(CMYK, G);
    expect(c).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_gloss_default_mimaki"] });
    expect(g).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
  });
  it("CMYK + _gloss / _GLOSS exact sibling pair -> both Mimaki", () => {
    for (const gloss of [GLOSS, "crud_HEATH_F_gloss.pdf", "crud_HEATH_F_G.pdf"]) {
      const [c, g] = pair(CMYK, gloss);
      expect([c.machine, g.machine], gloss).toEqual(["mimaki", "mimaki"]);
    }
  });
  it("both sibling files are recognised as layers of the SAME design and resolve to the same press", () => {
    expect(parseIntakeLayerTokens(CMYK)).toEqual({ layers: ["cmyk"], stem: "crud heath f" });
    expect(parseIntakeLayerTokens(G)).toEqual({ layers: ["gloss"], stem: "crud heath f" });
    expect(parseIntakeLayerTokens(GLOSS)).toEqual({ layers: ["gloss"], stem: "crud heath f" });
    expect(parseIntakeLayerTokens("crud_HEATH_F_cmyk.pdf").stem).toBe("crud heath f");
    const rows = [{ fileHashSha256: HASH("1"), originalFilename: G, authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" }];
    const context = buildIntakeMachineContext({ fileName: CMYK, fileHash: HASH("9"), jobId: "job_1", jobItemCount: 1, itemTicket: null, rows });
    expect(context.relatedFileNames).toEqual([G]);
    expect(decideIntakeMachine(item(), CMYK, context).machine).toBe("mimaki");
  });
  it("gloss alone on a job that is assigned to the Mimaki -> Mimaki (no contradiction any more)", () => {
    expect(decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), G)).toMatchObject({ machine: "mimaki", machineRule: "explicit_erp_machine" });
    expect(decideIntakeMachine(item({ selectedFinish: "Matte + 4X Spot Gloss", machineSummary: "Mimaki UCJV300-130" }))).toMatchObject({ machine: "mimaki", machineRule: "explicit_erp_machine" });
    expect(decideIntakeMachine(item(), G)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" }); // and with nothing explicit
    expect(decideIntakeMachine(item({ selectedFinish: "GLOSS-3X" }))).toMatchObject({ machine: "mimaki" });
  });
  it("through the matcher: a gloss job matched by its item ticket routes to the Mimaki", () => {
    const job: any = { id: "job_1", jobTicket: "GSO-20261118-0001", customerName: "c", company: null, status: "new", artworkUrl: null, printFileUrl: null, items: [item({ selectedFinish: "Matte + 2X Spot Gloss" })], fileNames: [] };
    expect(decideIntakeRoute({ fileName: "GSO-20261118-0001-01 art.pdf", jobs: [job] })).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" });
  });
});

describe("5-7. explicit instructions still win, and contradictions still review", () => {
  it("explicit ROLAND (ERP or filename tag) + CMYK / gloss pair -> the whole job on the Roland", () => {
    const [c, g] = pair(CMYK, G, { machineSummary: "Roland LG-640" });
    expect([c.machine, g.machine]).toEqual(["roland", "roland"]);
    expect(c.machineRule).toBe("explicit_erp_machine");
    // a ROLAND tag on EITHER layer file keeps both layers on the Roland
    const [c2, g2] = pair("crud_HEATH_F_CMYK_ROLAND.pdf", G);
    expect([c2.machine, g2.machine]).toEqual(["roland", "roland"]);
    expect(c2.machineRule).toBe("explicit_roland_tag");
  });
  it("explicit MIMAKI (ERP or filename tag) + CMYK / gloss pair -> both on the Mimaki", () => {
    const [c, g] = pair(CMYK, G, { machineSummary: "Mimaki UCJV300-130" });
    expect([c.machine, g.machine]).toEqual(["mimaki", "mimaki"]);
    const [c2, g2] = pair("crud_HEATH_F_CMYK_MIMAKI.pdf", G);
    expect([c2.machine, g2.machine]).toEqual(["mimaki", "mimaki"]);
    expect(c2.machineRule).toBe("explicit_mimaki_tag");
  });
  it("conflicting Roland / Mimaki instructions -> NEEDS REVIEW — PRINTER CONFLICT, never a press", () => {
    const cases = [
      decideIntakeMachine(item(), "crud_HEATH_F_CMYK_ROLAND_MIMAKI.pdf"),
      decideIntakeMachine(item(), "crud_HEATH_F_CMYK_MIMAKI.pdf", { relatedFileNames: ["crud_HEATH_F_g_ROLAND.pdf"] }),
      decideIntakeMachine(item({ machineSummary: "Roland LG-640" }), "crud_HEATH_F_g_MIMAKI.pdf"),
      decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "crud_HEATH_F_CMYK_ROLAND.pdf"),
    ];
    for (const decision of cases) {
      expect(decision.machine).toBeNull();
      expect(["printer_token_conflict", "printer_assignment_contradiction"]).toContain(canonicalReviewReason(decision.reasons));
    }
  });
  it("a pair is never split: if one layer already went to a press, the other is held rather than sent elsewhere", () => {
    const held = decideIntakeMachine(item(), G, { relatedFileNames: [CMYK], routedSiblingPrinters: ["roland"] });
    expect(held.machine).toBeNull();
    expect(canonicalReviewReason(held.reasons)).toBe("layer_printer_split");
    expect(decideIntakeMachine(item(), G, { relatedFileNames: [CMYK], routedSiblingPrinters: ["mimaki"] }).machine).toBe("mimaki");
  });
  it("no hidden gloss -> Roland fallback is left in the Print Intake resolver", () => {
    const lib = src("app/lib/print-intake-routing.server.ts");
    const resolver = lib.slice(lib.indexOf("export function decideIntakeMachine("), lib.indexOf("export type IntakeSiblingRow"));
    expect(resolver).not.toContain("gloss_requires_roland");
    expect(resolver).not.toContain("gloss_job_but_mimaki_selected_contradiction");
    expect(resolver).toContain('if (white && explicit === "mimaki") return blocked("white_job_but_mimaki_selected_contradiction");');
    const route = src("app/routes/api.print-intake.route-plan.tsx");
    expect(route).not.toMatch(/\bdecideMachine\(/); // the endpoint only uses the intake resolver
  });
});

describe("9. no fuzzy pairing; unrelated letters are not layers", () => {
  it("only an exact base name with a known layer suffix pairs", () => {
    const rows = ["crud_HEATH_B_g.pdf", "crud_HEATHER_F_g.pdf", "crud_HEATH_F2_g.pdf", "krud_HEATH_F_g.pdf", "crud_HEATH_F_gl.pdf", "crud_HEATH_F.pdf", "crud_HEATH_F_g.pdf"].map((name, index) => ({ fileHashSha256: HASH(String(index)), originalFilename: name, authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" }));
    const context = buildIntakeMachineContext({ fileName: CMYK, fileHash: HASH("9"), jobId: null, jobItemCount: 0, itemTicket: null, rows });
    expect(context.relatedFileNames).toEqual(["crud_HEATH_F_g.pdf"]);
  });
  it("letters and words elsewhere in a name are not layer indicators", () => {
    for (const name of ["g_money_label.pdf", "gloss_boss_F.pdf", "crud_glossy_F.pdf", "kk_1g_98mm.pdf", "kk_og_F.pdf", "crud_HEATH_F_gl.pdf", "crud_HEATH_F_gw.pdf", "big_g2_F.pdf", "kk_FROOT LOOPS TROP_F.pdf", "kk_FROOT LOOPS TROP_B.pdf"]) {
      expect(parseIntakeLayerTokens(name).layers, name).toEqual([]);
    }
    expect(parseIntakeLayerTokens("crud_HEATH_F_CMYK.pdf").layers).toEqual(["cmyk"]);
  });
});

describe("white is unchanged; primer is not gloss", () => {
  it("white still requires the Roland, and white + explicit Mimaki is still a conflict", () => {
    expect(decideIntakeMachine(item(), "crud_HEATH_F_w.pdf")).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    expect(decideIntakeMachine(item({ selectedFinish: "Holo + White + 4X Spot Gloss" })).machine).toBe("roland");
    const conflict = decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "crud_HEATH_F_w.pdf");
    expect(conflict.machine).toBeNull();
    expect(canonicalReviewReason(conflict.reasons)).toBe("premium_mode_mimaki_contradiction");
  });
  it("13. primer is NOT treated as gloss: it is still not routed and has no gloss price", () => {
    expect(decideIntakeMachine(item({ selectedFinish: "Primer + CMYK" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideIntakeMachine(item({ selectedFinish: "Primer", machineSummary: "Mimaki UCJV300-130" })).machine).toBeNull();
    expect(normalizeInkChannelKind("primer", "Primer")).toBe("other");
    expect(channelInkRatePerMl("mimaki", normalizeInkChannelKind("primer", "Primer"))).toBeNull();
    expect(normalizeInkChannelKind("clear", "Clear")).toBe("gloss");
    expect(normalizeInkChannelKind("gloss", "Gloss")).toBe("gloss");
  });
});

describe("10-12. cost: Mimaki clear / gloss is its own channel at $0.09/ml landed", () => {
  it("the rate is $90 / 1000 ml = $0.09/ml and nothing else moved", () => {
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBeCloseTo(0.09, 12);
    expect(channelInkRatePerMl("mimaki", "gloss")).toBeCloseTo(90 / 1000, 12);
    expect(CANONICAL_INK_RATES.mimakiCmykPerMl).toBe(176 / 1000); // CMYK preserved
    expect(CANONICAL_INK_RATES.mimakiWhitePerMl).toBe(176 / 1000);
    expect(CANONICAL_INK_RATES.rolandPerMl).toBe(149 / 750); // Roland preserved
    expect(channelInkRatePerMl("roland", "gloss")).toBe(149 / 750);
    expect(channelInkRatePerMl("mimaki", "gloss")).not.toBe(channelInkRatePerMl("roland", "gloss")); // never the Roland gloss price
    expect(channelInkRatePerMl("mimaki", "gloss")).not.toBe(channelInkRatePerMl("mimaki", "cmyk")); // never the CMYK price
  });
  it("a Mimaki CMYK + gloss actual costs CMYK ink + gloss ink, each on its own channel and its own consumption", () => {
    const rates = buildBrandRates([{ name: "Mimaki UCJV300-130", inkChannels: [] }, { name: "Roland TrueVIS LG-640", inkChannels: [] }]);
    const mimaki = computeEntryCosts({ machineName: "Mimaki UCJV300-130", cmykInkMl: 20, whiteInkMl: 0, glossInkMl: 12, inkMl: 32, printMinutes: 10 }, rates);
    expect(mimaki.inkCost).toBeCloseTo(20 * 0.176 + 12 * 0.09, 9);
    expect(mimaki.warnings.some((warning) => /gloss/i.test(warning))).toBe(false);
    // gloss usage is NOT assumed equal to CMYK usage: different ml -> different cost
    const lessGloss = computeEntryCosts({ machineName: "Mimaki UCJV300-130", cmykInkMl: 20, whiteInkMl: 0, glossInkMl: 3, inkMl: 23, printMinutes: 10 }, rates);
    expect(mimaki.inkCost! - lessGloss.inkCost!).toBeCloseTo(9 * 0.09, 9);
    const cmykOnly = computeEntryCosts({ machineName: "Mimaki UCJV300-130", cmykInkMl: 20, whiteInkMl: 0, glossInkMl: 0, inkMl: 20, printMinutes: 10 }, rates);
    expect(cmykOnly.inkCost).toBeCloseTo(20 * 0.176, 9);
  });
  it("Roland costing is unchanged: the same job on the Roland is priced at the Roland rate for every channel", () => {
    const rates = buildBrandRates([{ name: "Mimaki UCJV300-130", inkChannels: [] }, { name: "Roland TrueVIS LG-640", inkChannels: [] }]);
    const roland = computeEntryCosts({ machineName: "Roland LG-640", cmykInkMl: 20, whiteInkMl: 5, glossInkMl: 12, inkMl: 37, printMinutes: 10 }, rates);
    expect(roland.inkCost).toBeCloseTo(37 * (149 / 750), 9);
    const routing = src("app/lib/machine-routing.server.ts");
    expect(routing).toContain("mimaki: { cmyk: true, white: true, gloss: false },"); // quote / cost ESTIMATING is untouched until a Mimaki gloss usage calibration exists
    expect(routing).toContain('calibrationKey: "roland-gloss",');
  });
  it("RasterLink results already report clear / gloss as its own channel, and it is stored separately from CMYK", () => {
    const text = ["KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL", '"crud_HEATH_F_g.pdf","OK","C:0.000cc M:0.000cc Y:0.000cc K:0.000cc W:0.000cc W:0.000cc Cl:0.040cc Cl:0.035cc ","20261118_101500","20261118_101510",,,,', ',,,,,,,"130",'].join("\r\n");
    const row: any = parseRasterlinkRows(text, "20261118_101600_1_OK_print.csv")[0];
    expect(row.glossInkMl).toBeCloseTo(0.075 * 130, 6);
    expect(row.cmykInkMl).toBe(0);
    expect(row.whiteInkMl).toBe(0);
    expect(row.raw.perItem.clearCc).toBeCloseTo(0.075, 9); // both Cl slots, kept apart from CMYK and white
    const schema = src("prisma/schema.prisma");
    const entry = schema.split("model PrintLogEntry {")[1].split("\n}")[0];
    for (const column of ["cmykInkMl", "whiteInkMl", "glossInkMl"]) expect(entry, column).toMatch(new RegExp(`\\n\\s+${column}\\s+Float`)); // no schema change needed
  });
});
