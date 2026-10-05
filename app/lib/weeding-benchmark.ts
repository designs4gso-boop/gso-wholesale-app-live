// Weeding timing BENCHMARK helper (2026-10-05) — converts owner timing samples
// into calibration statistics. ANALYSIS ONLY: nothing here reads or writes the
// production standard. The owner compares several samples, chooses a standard,
// and then edits weeding-standard.ts deliberately. Client-safe, pure.

import { WEEDING_STANDARD, type WeedingStandard } from "./weeding-standard";

export const WEEDING_BENCHMARK_VERSION = "weeding-benchmark/1.0.0-2026-10-05";

export type WeedingDifficulty = "simple_rect" | "contour" | "complex_contour" | "specialty" | "mixed";

export type WeedingSample = {
  id: string;
  pages: number;
  pieces: number;
  elapsedMinutes: number;
  difficulty: WeedingDifficulty;
  notes?: string;
  /** Optional: what was weeded, for the record. */
  product?: string;
  operator?: string;
  recordedAt?: string;
};

export type SampleStats = {
  id: string;
  difficulty: WeedingDifficulty;
  minutesPerPage: number;
  pagesPerHour: number;
  piecesPerMinute: number;
  secondsPerPiece: number;
  laborCostPerPage: number;
  laborCostPerPiece: number;
  vsCurrentStandardPct: number; // +% slower (more cost per page) / -% faster than the current standard
  notes: string | null;
  product: string | null;
  operator: string | null;
  recordedAt: string | null;
  warnings: string[];
};

export type BenchmarkSummary = {
  version: string;
  standard: WeedingStandard;
  samples: SampleStats[];
  rejected: Array<{ id: string; reason: string }>;
  aggregate: null | {
    sampleCount: number;
    totalPages: number;
    totalPieces: number;
    totalMinutes: number;
    weightedPagesPerHour: number;
    meanPagesPerHour: number;
    medianPagesPerHour: number;
    minPagesPerHour: number;
    maxPagesPerHour: number;
    weightedLaborCostPerPage: number;
    byDifficulty: Record<string, { sampleCount: number; weightedPagesPerHour: number; weightedLaborCostPerPage: number }>;
  };
  /** Candidate values the owner COULD adopt — never applied automatically. */
  candidates: Array<{ label: string; pagesPerHour: number; costPerPage: number; basis: string }>;
};

const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function analyzeWeedingSample(s: WeedingSample, standard: WeedingStandard = WEEDING_STANDARD): SampleStats | { rejected: true; reason: string } {
  if (!(s.pages > 0)) return { rejected: true, reason: "pages must be > 0" };
  if (!(s.elapsedMinutes > 0)) return { rejected: true, reason: "elapsedMinutes must be > 0" };
  if (!(s.pieces >= 0)) return { rejected: true, reason: "pieces must be >= 0" };
  const minutesPerPage = s.elapsedMinutes / s.pages;
  const pagesPerHour = 60 / minutesPerPage;
  const laborCostPerPage = standard.laborRatePerHour / pagesPerHour;
  const warnings: string[] = [];
  if (s.elapsedMinutes < 5) warnings.push("very short sample (< 5 min); low statistical weight");
  if (s.pages < 1) warnings.push("fractional page sample");
  if (pagesPerHour > standard.pagesPerHour * 3) warnings.push("more than 3x the current standard — check that pages were counted as 54 in of feed, not labels");
  if (pagesPerHour < standard.pagesPerHour / 3) warnings.push("less than a third of the current standard — check for interruptions in the timing");
  return {
    id: s.id,
    difficulty: s.difficulty,
    minutesPerPage: r(minutesPerPage),
    pagesPerHour: r(pagesPerHour),
    piecesPerMinute: r(s.pieces / s.elapsedMinutes),
    secondsPerPiece: s.pieces > 0 ? r((s.elapsedMinutes * 60) / s.pieces) : 0,
    laborCostPerPage: r(laborCostPerPage, 6),
    laborCostPerPiece: s.pieces > 0 ? r((standard.laborRatePerHour / 60) * (s.elapsedMinutes / s.pieces), 6) : 0,
    vsCurrentStandardPct: r(((laborCostPerPage - standard.costPerPage) / standard.costPerPage) * 100, 2),
    notes: s.notes ?? null,
    product: s.product ?? null,
    operator: s.operator ?? null,
    recordedAt: s.recordedAt ?? null,
    warnings,
  };
}

export function summarizeWeedingBenchmark(samples: WeedingSample[], standard: WeedingStandard = WEEDING_STANDARD): BenchmarkSummary {
  const accepted: SampleStats[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  const raw: WeedingSample[] = [];
  for (const s of samples) {
    const a = analyzeWeedingSample(s, standard);
    if ("rejected" in a) rejected.push({ id: s.id, reason: a.reason }); else { accepted.push(a); raw.push(s); }
  }
  if (!accepted.length) return { version: WEEDING_BENCHMARK_VERSION, standard, samples: [], rejected, aggregate: null, candidates: [] };
  const totalPages = raw.reduce((t, s) => t + s.pages, 0);
  const totalPieces = raw.reduce((t, s) => t + s.pieces, 0);
  const totalMinutes = raw.reduce((t, s) => t + s.elapsedMinutes, 0);
  const weightedPagesPerHour = (totalPages / totalMinutes) * 60;
  const pph = accepted.map((a) => a.pagesPerHour).sort((a, b) => a - b);
  const median = pph.length % 2 ? pph[(pph.length - 1) / 2] : (pph[pph.length / 2 - 1] + pph[pph.length / 2]) / 2;
  const byDifficulty: BenchmarkSummary["aggregate"] extends infer A ? (A extends { byDifficulty: infer B } ? B : never) : never = {} as any;
  for (const d of new Set(raw.map((s) => s.difficulty))) {
    const rows = raw.filter((s) => s.difficulty === d);
    const p = rows.reduce((t, s) => t + s.pages, 0), m = rows.reduce((t, s) => t + s.elapsedMinutes, 0);
    const w = (p / m) * 60;
    byDifficulty[d] = { sampleCount: rows.length, weightedPagesPerHour: r(w), weightedLaborCostPerPage: r(standard.laborRatePerHour / w, 6) };
  }
  const candidates = [
    { label: "Time-weighted (all samples)", pagesPerHour: r(weightedPagesPerHour), costPerPage: r(standard.laborRatePerHour / weightedPagesPerHour, 6), basis: `${totalPages} pages in ${totalMinutes} min across ${accepted.length} sample(s)` },
    { label: "Median of samples", pagesPerHour: r(median), costPerPage: r(standard.laborRatePerHour / median, 6), basis: "median pages/hour; resistant to one outlier" },
    { label: "Conservative (slowest sample)", pagesPerHour: r(pph[0]), costPerPage: r(standard.laborRatePerHour / pph[0], 6), basis: "slowest observed sample" },
    { label: "Current standard (unchanged)", pagesPerHour: standard.pagesPerHour, costPerPage: r(standard.costPerPage, 6), basis: standard.source },
  ];
  return {
    version: WEEDING_BENCHMARK_VERSION,
    standard,
    samples: accepted,
    rejected,
    aggregate: { sampleCount: accepted.length, totalPages, totalPieces, totalMinutes, weightedPagesPerHour: r(weightedPagesPerHour), meanPagesPerHour: r(pph.reduce((a, b) => a + b, 0) / pph.length), medianPagesPerHour: r(median), minPagesPerHour: r(pph[0]), maxPagesPerHour: r(pph[pph.length - 1]), weightedLaborCostPerPage: r(standard.laborRatePerHour / weightedPagesPerHour, 6), byDifficulty },
    candidates,
  };
}

/** Owner input format (one line per sample) for a later admin tool: "id,pages,pieces,minutes,difficulty,notes" */
export function parseWeedingSamplesCsv(text: string): { samples: WeedingSample[]; errors: string[] } {
  const samples: WeedingSample[] = [];
  const errors: string[] = [];
  const difficulties: WeedingDifficulty[] = ["simple_rect", "contour", "complex_contour", "specialty", "mixed"];
  text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).forEach((line, i) => {
    const [id, pages, pieces, minutes, difficulty, ...notes] = line.split(",").map((c) => c.trim());
    const d = (difficulty || "mixed") as WeedingDifficulty;
    if (!id) { errors.push(`line ${i + 1}: missing id`); return; }
    if (!difficulties.includes(d)) { errors.push(`line ${i + 1}: difficulty must be one of ${difficulties.join("|")}`); return; }
    samples.push({ id, pages: Number(pages), pieces: Number(pieces || 0), elapsedMinutes: Number(minutes), difficulty: d, notes: notes.join(",") || undefined });
  });
  return { samples, errors };
}
