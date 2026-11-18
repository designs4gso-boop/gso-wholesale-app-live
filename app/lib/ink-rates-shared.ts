// Phase 15G.2 — ONE canonical ink $/ml authority. Client-safe, dependency-free.
//
// These are the current owner-approved rates already established in the repo
// (calculator-emergency INK_RATES + approved-cost-updates APPROVED_ROLL_COSTS):
//   Mimaki LUS-170 bottle  $176 / 1000 ml  (CMYK and white share the rate)
//   Roland ECO-UV pouch    $149 / 750 ml   (uniform across CMYK/white/gloss —
//                                           owner-approved provisional)
//   Mimaki clear / gloss   $90 / 1000 ml LANDED = $0.09/ml (owner, 2026-11-18:
//                          the UCJV300 gloss / clear channel is repaired and in
//                          production again). Clear / gloss ink — NOT primer.
//                          Landed cost: no freight is added on top. It is its
//                          own channel: never the CMYK rate, never the Roland rate.
//
// Every estimate AND actual-cost surface must price ink through these values
// (or channelInkRatePerMl below) so estimate-vs-actual variance reflects
// USAGE, never contradictory ink prices. MachineInkChannel rows remain
// inventory/reference data for usage modeling (mlPerSqft1Pct) — they are no
// longer an independent $/ml pricing authority.

export const CANONICAL_INK_RATES = {
  mimakiCmykPerMl: 176 / 1000,
  mimakiWhitePerMl: 176 / 1000,
  mimakiGlossPerMl: (90 / 1000) as number | null, // Mimaki clear / gloss, $90 per 1000 ml landed (2026-11-18)
  rolandPerMl: 149 / 750,
} as const;

export type InkBrand = "mimaki" | "roland";
export type InkChannelKind = "cmyk" | "white" | "gloss" | "other";

export function normalizeInkChannelKind(inkType: unknown, inkName?: unknown): InkChannelKind {
  const text = `${String(inkType || "")} ${String(inkName || "")}`.toLowerCase();
  if (/white/.test(text)) return "white";
  if (/gloss|clear/.test(text)) return "gloss";
  if (/cmyk|cyan|magenta|yellow|black/.test(text)) return "cmyk";
  return "other";
}

// The canonical $/ml for a brand + channel kind. null = no approved rate
// exists (unknown channels) — callers must warn/fail closed,
// never invent a number.
export function channelInkRatePerMl(brand: InkBrand, kind: InkChannelKind): number | null {
  if (brand === "roland") {
    if (kind === "cmyk" || kind === "white" || kind === "gloss") return CANONICAL_INK_RATES.rolandPerMl;
    return null;
  }
  if (kind === "cmyk") return CANONICAL_INK_RATES.mimakiCmykPerMl;
  if (kind === "white") return CANONICAL_INK_RATES.mimakiWhitePerMl;
  if (kind === "gloss") return CANONICAL_INK_RATES.mimakiGlossPerMl; // Mimaki clear / gloss
  return null; // unknown channel — never priced by guesswork
}

export function inkBrandFromMachineName(name: unknown): InkBrand | null {
  const text = String(name || "");
  if (/mimaki|ucjv/i.test(text)) return "mimaki";
  if (/roland|lg[-\s]?[56]40|truevis/i.test(text)) return "roland";
  return null;
}
