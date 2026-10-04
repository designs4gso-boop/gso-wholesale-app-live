// GSO Operations Agent Platform — Art Preflight (deterministic, technical only).
//
// Checks SUPPLIED file facts against GSO rules: accepted formats, artboard vs
// spec, GSO cutline (-0.0625in per side), white/gloss vs press capability,
// design count, sides, colour space, raster resolution, fonts. It does NOT
// parse PDF geometry itself — when a fact is unknown the finding is
// NEEDS_DESIGNER, never a guess. The agent may mark TECHNICAL_PREFLIGHT_PASSED
// only; customer and final approvals are human (art-approval.ts).

import { ARTWORK_EXTENSIONS } from "../print-intake-routing.server";
import { deriveGsoLabelCutlineFromArtboard, formatGsoCutline, GSO_CUTLINE_OFFSET_IN } from "../gso-cutline";
import { resolveCanonicalMachineRouting, ROUTING_REASONS } from "../machine-routing.server";

export const ART_PREFLIGHT_VERSION = "art-preflight/1.0.0-2026-10-03";

export type PreflightStatus = "PASS" | "WARN" | "FAIL" | "NEEDS_DESIGNER";

export type PreflightSpec = {
  family: string;
  widthIn?: number | null;
  heightIn?: number | null;
  sides?: number | null;
  designCount?: number | null;
  whiteLayers?: number | null;
  glossLayers?: number | null;
  whiteCoveragePct?: number | null;
  printerSelection?: string | null;
  cutType?: "rectangular" | "contour" | "none" | null;
};

export type ArtFileFacts = {
  fileName: string;
  fileHash?: string | null;
  artboardWidthIn?: number | null;
  artboardHeightIn?: number | null;
  pages?: number | null;
  colorSpace?: "CMYK" | "RGB" | "mixed" | "unknown" | null;
  minRasterDpi?: number | null;
  hasCutlineLayer?: boolean | null;
  fontsOutlined?: boolean | null;
};

export type Finding = { severity: "pass" | "warn" | "fail" | "needs_designer"; code: string; message: string; file?: string };

export type PreflightResult = {
  version: string;
  status: PreflightStatus;
  findings: Finding[];
  expectedCutline: string | null;
  routing: { printer: string; machineKey: string; blockers: string[] } | null;
  technicalPassEligible: boolean;
};

const TOL_IN = 0.01;
const DIM_FAMILIES = ["stickers-labels", "sticker-bags", "banners", "standard-jars", "premium-jars"];

export function runArtPreflight(spec: PreflightSpec, files: ArtFileFacts[]): PreflightResult {
  const f: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, message: string, file?: string) => f.push({ severity, code, message, file });

  if (!files.length) add("fail", "NO_ARTWORK", "no artwork file supplied");
  for (const file of files) {
    const ext = (file.fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    if (!ARTWORK_EXTENSIONS.includes(ext)) add("fail", "FORMAT_UNSUPPORTED", `"${ext || "no extension"}" is not an accepted artwork format (${ARTWORK_EXTENSIONS.join(", ")})`, file.fileName);
    if (DIM_FAMILIES.includes(spec.family)) {
      if (file.artboardWidthIn == null || file.artboardHeightIn == null) add("needs_designer", "ARTBOARD_UNKNOWN", "artboard size not supplied; designer must verify against spec", file.fileName);
      else if (spec.widthIn != null && spec.heightIn != null) {
        const direct = Math.abs(file.artboardWidthIn - spec.widthIn) <= TOL_IN && Math.abs(file.artboardHeightIn - spec.heightIn) <= TOL_IN;
        const rotated = Math.abs(file.artboardWidthIn - spec.heightIn) <= TOL_IN && Math.abs(file.artboardHeightIn - spec.widthIn) <= TOL_IN;
        if (!direct && !rotated) add("fail", "ARTBOARD_MISMATCH", `artboard ${file.artboardWidthIn} x ${file.artboardHeightIn} in does not match spec ${spec.widthIn} x ${spec.heightIn} in`, file.fileName);
        else if (rotated && !direct) add("warn", "ARTBOARD_ROTATED", "artboard matches spec rotated 90°", file.fileName);
      }
    }
    if (file.colorSpace === "RGB" || file.colorSpace === "mixed") add("warn", "COLOR_SPACE", `${file.colorSpace} colour detected; CMYK expected (conversion shifts colour)`, file.fileName);
    if (file.colorSpace == null || file.colorSpace === "unknown") add("needs_designer", "COLOR_SPACE_UNKNOWN", "colour space not supplied", file.fileName);
    if (file.minRasterDpi != null) {
      if (file.minRasterDpi < 150) add("fail", "LOW_RESOLUTION", `raster content at ${file.minRasterDpi} dpi (<150)`, file.fileName);
      else if (file.minRasterDpi < 300) add("warn", "RESOLUTION", `raster content at ${file.minRasterDpi} dpi (<300)`, file.fileName);
    }
    if (file.fontsOutlined === false) add("warn", "FONTS_NOT_OUTLINED", "fonts not outlined/embedded", file.fileName);
    if ((spec.cutType === "contour" || spec.cutType === "rectangular") && (spec.family === "stickers-labels" || spec.family === "sticker-bags")) {
      if (file.hasCutlineLayer === false) add("warn", "CUTLINE_MISSING", `no cutline layer; GSO applies the ${GSO_CUTLINE_OFFSET_IN}in inset rule`, file.fileName);
      if (file.hasCutlineLayer == null) add("needs_designer", "CUTLINE_UNKNOWN", "cutline presence not supplied", file.fileName);
    }
    if (spec.sides && spec.sides >= 2 && files.length === 1 && (file.pages ?? 1) < 2) add("warn", "SIDES_FILES", `${spec.sides} sides specified but one single-page file supplied`, file.fileName);
  }
  if (spec.designCount && spec.designCount > 1 && files.length < spec.designCount) {
    const pages = files.reduce((s, x) => s + (x.pages ?? 1), 0);
    if (pages < spec.designCount) add("warn", "DESIGN_COUNT", `${spec.designCount} designs specified but ${files.length} file(s)/${pages} page(s) supplied`);
  }

  let expectedCutline: string | null = null;
  if ((spec.family === "stickers-labels" || spec.family === "sticker-bags") && spec.cutType !== "none") {
    const cut = deriveGsoLabelCutlineFromArtboard(spec.widthIn, spec.heightIn);
    expectedCutline = cut ? formatGsoCutline(cut) : null;
    if (!cut && spec.widthIn != null) add("fail", "CUTLINE_UNDERIVABLE", "artboard too small for the GSO cutline inset");
  }

  let routing: PreflightResult["routing"] = null;
  const r = resolveCanonicalMachineRouting({ printerSelection: spec.printerSelection ?? "auto", whiteLayers: spec.whiteLayers ?? 0, glossLayers: spec.glossLayers ?? 0, whiteCoveragePct: spec.whiteCoveragePct ?? null });
  const artBlockers = r.reasons.filter((x) => x === ROUTING_REASONS.mimakiSpecialtyUnsupported || x === ROUTING_REASONS.invalidLayers);
  routing = { printer: r.effectivePrinter, machineKey: r.machineKey, blockers: artBlockers };
  if (artBlockers.includes(ROUTING_REASONS.mimakiSpecialtyUnsupported)) add("fail", ROUTING_REASONS.mimakiSpecialtyUnsupported, "white/gloss requested with the Mimaki explicitly selected; the Mimaki is CMYK-only");
  if (artBlockers.includes(ROUTING_REASONS.invalidLayers)) add("fail", ROUTING_REASONS.invalidLayers, "white/gloss layer counts must be whole numbers ≥ 0");
  if ((spec.whiteLayers ?? 0) > 0 && spec.whiteCoveragePct == null) add("warn", ROUTING_REASONS.whiteCoverageRequired, "white selected; operator must supply white coverage (never defaulted) before costing");

  const has = (s: Finding["severity"]) => f.some((x) => x.severity === s);
  const status: PreflightStatus = has("fail") ? "FAIL" : has("needs_designer") ? "NEEDS_DESIGNER" : has("warn") ? "WARN" : "PASS";
  return { version: ART_PREFLIGHT_VERSION, status, findings: f, expectedCutline, routing, technicalPassEligible: status === "PASS" || status === "WARN" };
}
