import { safeNumber } from "./recipe-pricing.server";
import { resolvePrintMaterialCostPerSqft } from "./cost-calculator.server";

// Read-only actual-cost math for the RIP dashboard (13A.5). Pure functions
// taking data as parameters — no Prisma, no Shopify, no writes. Ink rates
// come from the DB machine ink channels (verified in 13.2.4), NEVER from
// hardcoded guesses: when a rate cannot be attributed, the row gets a loud
// warning and a null ink cost instead of a silent number.

// Client-safe constants live in rip-actual-costs-shared.ts (the route
// component imports them there); re-exported here so tests and the loader
// use one import path.
export { MACHINE_RATE_CURRENT, MACHINE_RATE_HIGH, MACHINE_RATE_LOW, MATCH_STATUS_LABELS } from "./rip-actual-costs-shared";
export type { MatchStatus } from "./rip-actual-costs-shared";
import { MACHINE_RATE_CURRENT, MACHINE_RATE_HIGH, MACHINE_RATE_LOW } from "./rip-actual-costs-shared";
import type { MatchStatus } from "./rip-actual-costs-shared";

export function machineCost(printMinutes: number, ratePerHour: number) {
  return (Math.max(0, safeNumber(printMinutes)) / 60) * safeNumber(ratePerHour);
}

// The ONE configurable machine-rate source (owner decision 13A.7B: $8/hr).
// Env override GSO_MACHINE_RATE_PER_HOUR wins when set to a positive number;
// otherwise the shared MACHINE_RATE_CURRENT constant applies. Board previews,
// the audit page, and print-log writeback must all call this.
export function machineRatePerHour(env: Record<string, string | undefined> = process.env): number {
  const override = Number(env.GSO_MACHINE_RATE_PER_HOUR);
  return Number.isFinite(override) && override > 0 ? override : MACHINE_RATE_CURRENT;
}

// ---------- machine attribution + per-brand ink rates ----------

export type MachineBrand = "mimaki" | "roland";

export type BrandInkRates = {
  brand: MachineBrand;
  machineName: string;
  cmykPerMl: number | null;
  whitePerMl: number | null;
  glossPerMl: number | null;
};

function averageRate(channels: Array<{ inkType?: string | null; inkName?: string | null; enabled?: boolean; costPerMl?: number; cartridgeCost?: number; cartridgeMl?: number }>, matcher: RegExp): number | null {
  const rates = channels
    .filter((channel) => channel.enabled !== false)
    .filter((channel) => matcher.test(`${channel.inkType || ""} ${channel.inkName || ""}`))
    .map((channel) => {
      const direct = safeNumber(channel.costPerMl);
      if (direct > 0) return direct;
      const cart = safeNumber(channel.cartridgeCost);
      const ml = safeNumber(channel.cartridgeMl);
      return cart > 0 && ml > 0 ? cart / ml : 0;
    })
    .filter((rate) => rate > 0);
  if (!rates.length) return null;
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

export function buildBrandRates(machines: Array<{ name?: string | null; inkChannels?: any[] }>): BrandInkRates[] {
  const out: BrandInkRates[] = [];
  for (const machine of machines) {
    const name = String(machine.name || "");
    const brand: MachineBrand | null = /mimaki/i.test(name) ? "mimaki" : /roland/i.test(name) ? "roland" : null;
    if (!brand || out.some((entry) => entry.brand === brand)) continue;
    const channels = machine.inkChannels || [];
    out.push({
      brand,
      machineName: name,
      cmykPerMl: averageRate(channels, /cmyk|cyan|magenta|yellow|black/i),
      whitePerMl: averageRate(channels, /white/i),
      glossPerMl: averageRate(channels, /gloss|clear/i),
    });
  }
  return out;
}

// Attribution order: explicit machine name from the log, then the RIP
// software (VersaWorks = Roland, RasterLink = Mimaki), then the ROUTE token
// the intake watcher embeds in job file names. Null = cannot attribute.
export function attributeMachine(entry: { machineName?: string | null; printerSoftware?: string | null; sourceJobName?: string | null }): MachineBrand | null {
  const name = String(entry.machineName || "");
  if (/mimaki|ucjv/i.test(name)) return "mimaki";
  // 13A.7B normalization: the shop's Roland is the LG-640 (operational hot
  // folders are named LG640-*); LG-540 stays matched for historical rows.
  if (/roland|lg[-\s]?[56]40|truevis/i.test(name)) return "roland";
  const software = String(entry.printerSoftware || "");
  if (/rasterlink/i.test(software)) return "mimaki";
  if (/versaworks/i.test(software)) return "roland";
  const jobName = String(entry.sourceJobName || "");
  if (/[_-]roland[_-]|[_-]lg[_-]/i.test(jobName)) return "roland";
  if (/[_-]mimaki[_-]/i.test(jobName)) return "mimaki";
  return null;
}

// ---------- per-entry cost computation ----------

export type EntryInput = {
  machineName?: string | null;
  printerSoftware?: string | null;
  sourceJobName?: string | null;
  cmykInkMl: number;
  whiteInkMl: number;
  glossInkMl: number;
  inkMl: number;
  printMinutes: number;
};

export type EntryCosts = {
  brand: MachineBrand | null;
  inkCost: number | null;
  machineCostLow: number;
  machineCostHigh: number;
  warnings: string[];
};

export function computeEntryCosts(entry: EntryInput, rates: BrandInkRates[]): EntryCosts {
  const warnings: string[] = [];
  const brand = attributeMachine(entry);
  const brandRates = brand ? rates.find((rate) => rate.brand === brand) || null : null;

  const cmyk = Math.max(0, safeNumber(entry.cmykInkMl));
  const white = Math.max(0, safeNumber(entry.whiteInkMl));
  const gloss = Math.max(0, safeNumber(entry.glossInkMl));
  const totalMl = Math.max(safeNumber(entry.inkMl), cmyk + white + gloss);

  let inkCost: number | null = null;
  if (!brand) {
    warnings.push("Machine could not be attributed (no name/software/route token) — ink cost not calculated.");
  } else if (!brandRates) {
    warnings.push(`No ${brand} machine with channel costs found in the database — ink cost not calculated.`);
  } else {
    let cost = 0;
    let usable = true;
    const channelSplitKnown = cmyk + white + gloss > 0;
    if (channelSplitKnown) {
      if (cmyk > 0) {
        if (brandRates.cmykPerMl == null) { warnings.push("No CMYK channel cost — CMYK ink excluded from cost."); usable = cmyk === totalMl ? false : usable; }
        else cost += cmyk * brandRates.cmykPerMl;
      }
      if (white > 0) {
        if (brandRates.whitePerMl == null) { warnings.push("No white channel cost — white ink excluded from cost."); }
        else cost += white * brandRates.whitePerMl;
      }
      if (gloss > 0) {
        if (brandRates.glossPerMl == null) { warnings.push("No gloss/clear channel cost — gloss ink excluded from cost."); }
        else cost += gloss * brandRates.glossPerMl;
      }
      inkCost = usable ? cost : null;
    } else if (totalMl > 0) {
      // Only a total is known: price it at the CMYK rate and say so.
      if (brandRates.cmykPerMl == null) {
        warnings.push("Only total ink ml known and no CMYK channel cost — ink cost not calculated.");
      } else {
        inkCost = totalMl * brandRates.cmykPerMl;
        warnings.push("Channel split unknown — total ml priced at the CMYK rate.");
      }
    }
  }

  if (totalMl <= 0) warnings.push("Missing ink ml.");
  if (safeNumber(entry.printMinutes) <= 0) warnings.push("Missing print minutes.");

  // Routing business rule (13A.4, warn-only in 13A.5): Mimaki is CMYK-only.
  if (brand === "mimaki" && white + gloss > 0) {
    warnings.push("ROUTING: white/gloss ink on Mimaki — business rule says Mimaki is CMYK-only; this job should carry the ROLAND tag.");
  }

  return {
    brand,
    inkCost,
    machineCostLow: machineCost(entry.printMinutes, MACHINE_RATE_LOW),
    machineCostHigh: machineCost(entry.printMinutes, MACHINE_RATE_HIGH),
    warnings,
  };
}

// ---------- match status ----------

export function matchStatusOf(entry: { productionJobId?: string | null; jobTicket?: string | null }): MatchStatus {
  if (entry.productionJobId) return "matched";
  const ticket = String(entry.jobTicket || "");
  if (/^GSOQ-/i.test(ticket)) return "quote_rip";
  if (/^GSO-/i.test(ticket)) return "potentially_matchable";
  return "missing_ticket";
}

// ---------- media/material display matching (read-only, never persisted) ----------

export function matchMediaToMaterial(
  mediaName: unknown,
  materials: Array<{ id: string; name: string | null; calculatedUnitCost?: number; costPerUnit?: number; purchaseCost?: number; baseUnit?: string | null; unit?: string | null }>,
): { material: { id: string; name: string | null } | null; costPerSqft: number | null; warning: string | null } {
  const media = String(mediaName || "").trim().toLowerCase();
  if (!media) return { material: null, costPerSqft: null, warning: "No media name in the log row." };
  const hits = materials.filter((material) => {
    const name = String(material.name || "").trim().toLowerCase();
    return name && (name.includes(media) || media.includes(name));
  });
  if (!hits.length) return { material: null, costPerSqft: null, warning: `Media "${String(mediaName)}" does not match any Material by name — media cost not shown.` };
  if (hits.length > 1) return { material: null, costPerSqft: null, warning: `Media "${String(mediaName)}" matches ${hits.length} Materials — ambiguous, media cost not shown.` };
  const resolved = resolvePrintMaterialCostPerSqft(hits[0]);
  return {
    material: { id: hits[0].id, name: hits[0].name },
    costPerSqft: resolved.unitCost > 0 ? resolved.unitCost : null,
    warning: resolved.unitCost > 0 ? null : `Matched Material "${hits[0].name}" has no usable $/sqft.`,
  };
}

// ---------- per-ticket rollup ----------

export type RollupInput = {
  jobTicket: string;
  productionJobId: string | null;
  machineBrand: MachineBrand | null;
  machineName: string;
  mediaName: string;
  inkMl: number;
  inkCost: number | null;
  printMinutes: number;
};

export type TicketRollup = {
  jobTicket: string;
  productionJobId: string | null;
  rowCount: number;
  totalInkMl: number;
  totalInkCost: number;
  inkCostComplete: boolean;
  totalPrintMinutes: number;
  machineCostLow: number;
  machineCostHigh: number;
  machines: string[];
  medias: string[];
  warnings: string[];
};

export function rollupByTicket(rows: RollupInput[]): TicketRollup[] {
  const byTicket = new Map<string, RollupInput[]>();
  for (const row of rows) {
    if (!row.jobTicket) continue;
    const list = byTicket.get(row.jobTicket) || [];
    list.push(row);
    byTicket.set(row.jobTicket, list);
  }

  return [...byTicket.entries()].map(([jobTicket, ticketRows]) => {
    const machines = [...new Set(ticketRows.map((row) => row.machineName || (row.machineBrand ?? "unknown")).filter(Boolean))];
    const medias = [...new Set(ticketRows.map((row) => row.mediaName).filter(Boolean))];
    const warnings: string[] = [];
    if (machines.length > 1) warnings.push(`Multiple machines on one ticket: ${machines.join(", ")}.`);
    if (medias.length > 1) warnings.push(`Multiple media types on one ticket: ${medias.join(", ")}.`);
    const inkCostComplete = ticketRows.every((row) => row.inkCost != null);
    if (!inkCostComplete) warnings.push("Some rows have no calculable ink cost — ticket ink total is partial.");
    const totalPrintMinutes = ticketRows.reduce((sum, row) => sum + Math.max(0, safeNumber(row.printMinutes)), 0);

    return {
      jobTicket,
      productionJobId: ticketRows.find((row) => row.productionJobId)?.productionJobId || null,
      rowCount: ticketRows.length,
      totalInkMl: ticketRows.reduce((sum, row) => sum + Math.max(0, safeNumber(row.inkMl)), 0),
      totalInkCost: ticketRows.reduce((sum, row) => sum + (row.inkCost ?? 0), 0),
      inkCostComplete,
      totalPrintMinutes,
      machineCostLow: machineCost(totalPrintMinutes, MACHINE_RATE_LOW),
      machineCostHigh: machineCost(totalPrintMinutes, MACHINE_RATE_HIGH),
      machines,
      medias,
      warnings,
    };
  }).sort((a, b) => b.totalInkCost - a.totalInkCost);
}

// ---------- GSOQ quote-time rows (separate section) ----------

export function parseGsoqRow(entry: { jobTicket?: string | null; sourceJobName?: string | null; createdAt: Date | string; inkMl: number; printMinutes: number; rawRow?: string | null }) {
  let raw: Record<string, unknown> = {};
  try {
    raw = entry.rawRow ? (JSON.parse(entry.rawRow) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    quoteId: String(raw.quoteId || entry.jobTicket || ""),
    fileName: String(raw.fileName || entry.sourceJobName || ""),
    date: String(raw.importedAt || entry.createdAt),
    totalCc: num(raw.totalCc) || safeNumber(entry.inkMl),
    ripSeconds: num(raw.ripSeconds) || Math.round(safeNumber(entry.printMinutes) * 60),
    nasInkCost: num(raw.estimatedInkCost),
  };
}
