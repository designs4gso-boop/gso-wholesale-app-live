// 2026-10-21 — LAUNCH READINESS UX CLEANUP (presentation only).
//
// Groups the Setup Wizard loader's existing steps for the Launch Readiness
// page. Nothing here decides readiness: status / severity / progress / next
// step all come from the loader unchanged. Pure + client-safe.

export type ReadinessStatus = "Ready" | "Needs setup" | "Needs review" | "Needs first test order" | "Partial";
export type ReadinessSeverity = "ready" | "warning" | "blocker";

export type ReadinessStep = {
  name: string;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  explanation: string;
  summary?: string;
  counts: string[];
  details?: string[];
  links: { label: string; url: string }[];
};

export const LAUNCH_READINESS_TITLE = "Launch Readiness";
export const LAUNCH_READINESS_SUBTITLE = "System readiness & launch checklist";

/** Blockers, then warnings, then non-blocking review items, then fully ready sections. */
export function groupReadinessSteps<T extends ReadinessStep>(steps: T[]) {
  return {
    blockers: steps.filter((step) => step.severity === "blocker"),
    warnings: steps.filter((step) => step.severity === "warning"),
    needsReview: steps.filter((step) => step.severity === "ready" && step.status !== "Ready"),
    ready: steps.filter((step) => step.severity === "ready" && step.status === "Ready"),
  };
}

/**
 * One plain-English sentence for the Quote Pipeline card that NAMES what is
 * unresolved (2026-11-12: never a generic "at least N" count). The loader
 * deep-checks a bounded sample of recipes and lists every failure in it; jar
 * geometry issues arrive already resolved to their canonical answer
 * (jar-recipe-geometry.ts), e.g. "Miron 50ml — label geometry pending owner sample".
 */
export function quotePipelineSummary(failingSamples: { name: string; firstIssue: string }[], quoteReadyRecipes: number) {
  if (quoteReadyRecipes === 0) return "No recipes are quote-ready yet.";
  if (failingSamples.length === 0) return null;
  const items = failingSamples.map((sample) => (sample.firstIssue.includes(" — ") ? sample.firstIssue : `${sample.name}: ${sample.firstIssue}`));
  return `Not quote-ready yet: ${items.join("; ")}.`;
}

/** The step "Fix Next Issue" opens: the loader's existing nextStep, else the first warning. */
export function nextIssueStep<T extends ReadinessStep>(nextStep: T | null, steps: T[]) {
  return nextStep ?? steps.find((step) => step.severity !== "ready") ?? null;
}
