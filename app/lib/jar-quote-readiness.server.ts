// 2026-11-12 — LAUNCH READINESS aligned with the CANONICAL quote authorities.
//
// A Product Setup recipe answers two different questions:
//
//   A. QUOTE READINESS — can the canonical calculator quote this product
//      safely? For an ACTIVE jar that needs exactly what the canonical jar
//      engine reads: confirmed label geometry (jar-label-geometry.ts), a
//      verified blank cost (resolveJarBlankCost) and at least one compatible
//      press under the canonical routing rules (machine-routing.server.ts).
//      The recipe's own preferredMachine / width / height are NOT read by that
//      engine, so they are not quote requirements.
//
//   B. AGENT AUTO-CONVERSION READINESS — the agent queue converts through the
//      LEGACY recipe engine (recipe-pricing.server.ts), which does read the
//      recipe's preferred machine, width / height and materials. Those gaps are
//      reported under Agent Platform; blockingConversionIssues is unchanged.
//
// An INACTIVE jar recipe (outside the active jar scope, e.g. the 5oz cost-only
// placeholder) is informational and never counts toward launch readiness.
// Non-jar recipes keep the existing engine checks unchanged.

import { MACHINE_CAPABILITIES, type PrinterBrand } from "./machine-routing.server";
import { PRIMER_NOT_CONFIGURED } from "./print-intake-routing.server";
import { resolveJarBlankCost, type JarBrand } from "./jar-cost-inputs.server";
import { resolveActiveJarProfile, resolveActiveJarVariant } from "./jar-active-scope";
import { jarRecipeGeometryStatus } from "./jar-recipe-geometry";
import type { JarSizeKey } from "./jar-label-geometry";

export const NO_COMPATIBLE_PRINTER = "NO_COMPATIBLE_PRINTER";

export type ReadinessLayers = { whiteLayers?: number; glossLayers?: number; primer?: boolean };

export type RoutingAvailability =
  | { ok: true; printers: PrinterBrand[] }
  | { ok: false; reason: typeof PRIMER_NOT_CONFIGURED | typeof NO_COMPATIBLE_PRINTER; message: string };

/**
 * Is there at least one press that can print these layers under the
 * canonical capability table? (Same rule as compatiblePrinters; Primer is
 * never configured on any GSO press.) Load, AUTO and operator selection are
 * quote-time concerns and never make a PRODUCT unready.
 */
export function canonicalRoutingAvailable(
  layers: ReadinessLayers = {},
  capabilities: Record<PrinterBrand, { cmyk: boolean; white: boolean; gloss: boolean }> = MACHINE_CAPABILITIES,
): RoutingAvailability {
  if (layers.primer) return { ok: false, reason: PRIMER_NOT_CONFIGURED, message: "Primer is not configured on any GSO press" };
  const white = Number(layers.whiteLayers ?? 0) > 0;
  const gloss = Number(layers.glossLayers ?? 0) > 0;
  const printers = (Object.keys(capabilities) as PrinterBrand[]).filter(
    (p) => capabilities[p].cmyk && (!white || capabilities[p].white) && (!gloss || capabilities[p].gloss),
  );
  return printers.length
    ? { ok: true, printers }
    : { ok: false, reason: NO_COMPATIBLE_PRINTER, message: "no press can print this configuration under the canonical routing rules" };
}

export type RecipeReadiness = {
  scope: "jar_active" | "jar_inactive" | "other";
  /** Issues that stop a valid canonical quote of this (active) product. Empty = quote-ready. */
  quoteIssues: string[];
  /** Legacy-engine gaps that only block AUTOMATIC agent-queue conversion. */
  agentConversionIssues: string[];
  /** Not launch-blocking notes (inactive placeholders). */
  informational: string[];
};

export function classifyRecipeReadiness(
  recipe: { name?: string | null; productType?: string | null },
  engineIssues: string[],
  options: { layers?: ReadinessLayers; capabilities?: Record<PrinterBrand, { cmyk: boolean; white: boolean; gloss: boolean }> } = {},
): RecipeReadiness {
  const geometry = jarRecipeGeometryStatus(recipe);
  if (geometry.kind === "not_jar") return { scope: "other", quoteIssues: engineIssues, agentConversionIssues: [], informational: [] };
  if (geometry.kind === "unsupported") {
    return { scope: "jar_inactive", quoteIssues: [], agentConversionIssues: [], informational: [`${geometry.message} (inactive — not launch-blocking)`] };
  }

  const quoteIssues: string[] = [];
  if (geometry.kind === "pending") quoteIssues.push(geometry.message);

  const profile = resolveActiveJarProfile(recipe.name)!;
  const blank = resolveJarBlankCost({
    brand: profile.brand as JarBrand,
    size: profile.size as JarSizeKey,
    quantity: 1,
    variant: profile.brand === "standard" ? resolveActiveJarVariant(recipe.name) ?? undefined : undefined,
  });
  if (!blank.ok) quoteIssues.push(`${profile.label} — ${blank.message}`);

  const routing = canonicalRoutingAvailable(options.layers, options.capabilities);
  if (!routing.ok) quoteIssues.push(`${profile.label} — ${routing.reason}: ${routing.message}`);

  return { scope: "jar_active", quoteIssues, agentConversionIssues: engineIssues, informational: [] };
}
