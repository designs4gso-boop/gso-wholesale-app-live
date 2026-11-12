// 2026-11-12 live QA — jar recipe geometry for LAUNCH READINESS (pure, client-safe).
//
// Jar label geometry is canonical (jar-label-geometry.ts, owner-confirmed per
// size); the Product Setup recipe width / height fields were never filled for
// jars (tools/seed-jar-erp-foundation.mjs creates them without dimensions), so
// the readiness sample reported every jar recipe as "missing width or height".
// Readiness now asks the canonical resolver instead of a duplicate field:
//   confirmed   — owner-confirmed size: the dimension issue is satisfied
//   pending     — e.g. 50ml: named specifically, still not ready
//   unsupported — a jar recipe outside the active jar scope (e.g. the 5oz
//                 cost-only placeholder): named specifically, still not ready
// This does NOT relax blockingConversionIssues — the agent-queue conversion
// still prices from the recipe fields and keeps requiring them.

import { resolveActiveJarProfile } from "./jar-active-scope";
import { jarGeometryAuthorityFor } from "./jar-label-geometry";

export const RECIPE_MISSING_DIMENSIONS_ISSUE = "recipe is missing width or height";

export type JarRecipeGeometry =
  | { kind: "not_jar" }
  | { kind: "confirmed"; size: string; label: string }
  | { kind: "pending"; size: string; label: string; message: string }
  | { kind: "unsupported"; label: string; message: string };

const isJarRecipe = (recipe: { name?: string | null; productType?: string | null }) =>
  /^jar_/i.test(String(recipe.productType || "")) || /\bjar\b/i.test(String(recipe.name || ""));

export function jarRecipeGeometryStatus(recipe: { name?: string | null; productType?: string | null }): JarRecipeGeometry {
  if (!isJarRecipe(recipe)) return { kind: "not_jar" };
  const name = String(recipe.name || recipe.productType || "jar recipe");
  const profile = resolveActiveJarProfile(recipe.name);
  if (!profile) {
    return { kind: "unsupported", label: name, message: `${name} — not an active jar product; no confirmed label geometry` };
  }
  if (jarGeometryAuthorityFor(profile.size).authorityStatus === "OWNER_CONFIRMED") {
    return { kind: "confirmed", size: profile.size, label: profile.label };
  }
  return { kind: "pending", size: profile.size, label: profile.label, message: `${profile.label} — label geometry pending owner sample` };
}

/**
 * Readiness issues for one recipe: the engine's issues, with the duplicate
 * "missing width or height" replaced by the canonical jar answer.
 */
export function readinessIssuesForRecipe(recipe: { name?: string | null; productType?: string | null }, issues: string[]): string[] {
  const geometry = jarRecipeGeometryStatus(recipe);
  if (geometry.kind === "not_jar") return issues;
  return issues.flatMap((issue) => {
    if (issue !== RECIPE_MISSING_DIMENSIONS_ISSUE) return [issue];
    if (geometry.kind === "confirmed") return [];
    return [geometry.message];
  });
}
