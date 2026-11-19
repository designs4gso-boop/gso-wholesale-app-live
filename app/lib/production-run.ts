// 2026-11-19 — production runs of ONE item (shared by the admin and the
// production lane). Pure, client-safe, no Prisma.
//
// Run 1 is the original production of an item. Every reprint / remake is a
// further run on the SAME item and the SAME item ticket. A run records what
// was produced again and why; it never changes the item's ordered quantity or
// its price, so an internal remake can only ever add cost / waste, never
// revenue. A customer-paid replacement is recorded here for the floor, and the
// money is handled by a separate commercial transaction (quote / invoice).

export const RUN_KINDS = [
  { value: "reprint", label: "Reprint (same file, print again)" },
  { value: "remake", label: "Remake (redo the piece: print + finish)" },
] as const;
export type RunKind = "original" | (typeof RUN_KINDS)[number]["value"];

export const RUN_CHARGE_TYPES = [
  { value: "internal", label: "Internal — no charge" },
  { value: "warranty", label: "Warranty / replacement — no charge" },
  { value: "customer_paid", label: "Customer-paid" },
] as const;
export type RunChargeType = (typeof RUN_CHARGE_TYPES)[number]["value"];

export const REPRINT_QTY_MAX = 1_000_000;

export function isRunKind(value: unknown): value is "reprint" | "remake" {
  return RUN_KINDS.some((kind) => kind.value === value);
}
export function isRunChargeType(value: unknown): value is RunChargeType {
  return RUN_CHARGE_TYPES.some((type) => type.value === value);
}
export function runChargeLabel(value: unknown): string {
  return RUN_CHARGE_TYPES.find((type) => type.value === value)?.label || "Internal — no charge";
}
export function runKindLabel(value: unknown): string {
  if (value === "original") return "Original";
  return value === "remake" ? "Remake" : "Reprint";
}

/**
 * The reprint quantity as typed. Required: a whole number of 1 or more. Blank
 * is refused (never guessed, never defaulted to the ordered quantity).
 */
export function parseReprintQuantity(raw: unknown): { ok: true; quantity: number } | { ok: false; reason: string } {
  const text = String(raw ?? "").trim().replace(/,/g, "");
  if (!text) return { ok: false, reason: "Enter how many pieces to reprint." };
  if (!/^\d+$/.test(text)) return { ok: false, reason: "Reprint quantity must be a whole number." };
  const quantity = Number(text);
  if (quantity < 1) return { ok: false, reason: "Reprint quantity must be 1 or more." };
  if (quantity > REPRINT_QTY_MAX) return { ok: false, reason: "Reprint quantity is too large." };
  return { ok: true, quantity };
}

export type RunRow = {
  id?: string;
  itemId: string;
  runNumber: number;
  kind: string;
  quantity: number;
  reasonCode?: string | null;
  chargeType?: string | null;
  status?: string | null;
  runLabel?: string | null;
  requestedBy?: string | null;
  notes?: string | null;
  createdAt?: Date | string | null;
};

export type PlannedRun = { runNumber: number; kind: RunKind; quantity: number; status: string };

/**
 * What a new reprint / remake writes. The original run (run 1) is written the
 * first time it is needed, from the item's ordered quantity, so items produced
 * before runs existed get a complete history without a backfill.
 */
export function planReprintRuns(
  existing: RunRow[],
  item: { quantity: number; qcResult?: string | null },
  request: { kind: "reprint" | "remake"; quantity: number },
): { original: PlannedRun | null; next: PlannedRun } {
  const numbers = existing.map((run) => Number(run.runNumber) || 0);
  const hasOriginal = existing.some((run) => run.kind === "original" || Number(run.runNumber) === 1);
  const original: PlannedRun | null = hasOriginal
    ? null
    : { runNumber: 1, kind: "original", quantity: Math.max(0, Math.floor(Number(item.quantity) || 0)), status: item.qcResult === "pass" ? "qc_passed" : "reprinted" };
  const highest = Math.max(original ? 1 : 0, ...numbers, 0);
  return { original, next: { runNumber: highest + 1, kind: request.kind, quantity: request.quantity, status: "open" } };
}

/** The run a QC result applies to: the newest run that is still open. */
export function openRunOf<T extends RunRow>(runs: T[]): T | null {
  return [...runs].filter((run) => run.status === "open").sort((a, b) => Number(b.runNumber) - Number(a.runNumber))[0] || null;
}

/** QC result -> run status (hold leaves the run open). */
export function runStatusForQc(result: string): string | null {
  if (result === "pass") return "qc_passed";
  if (result === "reprint_required") return "qc_failed";
  return null;
}

export type ItemRunSummary = {
  orderedQuantity: number;
  /** What the customer is charged for: ALWAYS the ordered quantity. Runs never change it. */
  billableQuantity: number;
  reprintCount: number;
  reprintQuantity: number;
  internalReprintQuantity: number;
  customerPaidReprintQuantity: number;
  runs: RunRow[];
};

/** Ordered quantity and reprint quantity are kept apart: 500 ordered + 25 reprinted is never 525 ordered. */
export function itemRunSummary(item: { quantity: number }, runs: RunRow[]): ItemRunSummary {
  const sorted = [...runs].sort((a, b) => Number(a.runNumber) - Number(b.runNumber));
  const extra = sorted.filter((run) => run.kind !== "original" && run.status !== "cancelled");
  const sum = (rows: RunRow[]) => rows.reduce((total, run) => total + (Number(run.quantity) || 0), 0);
  const ordered = Number(item.quantity) || 0;
  return {
    orderedQuantity: ordered,
    billableQuantity: ordered,
    reprintCount: extra.length,
    reprintQuantity: sum(extra),
    internalReprintQuantity: sum(extra.filter((run) => run.chargeType !== "customer_paid")),
    customerPaidReprintQuantity: sum(extra.filter((run) => run.chargeType === "customer_paid")),
    runs: sorted,
  };
}

/* ---------------- multi-layer re-route ---------------- */

export type IntakeLayerRow = {
  id: string;
  originalFilename: string;
  status: string;
  routedFilename: string | null;
  revisionNumber: number;
  reprintNumber: number;
  attemptNumber: number;
  updatedAt?: Date | string | null;
};

const REROUTABLE = new Set(["routed", "retry_allowed", "assigned"]);

/**
 * Every file an item needs printed again: the newest routed row per staff file
 * name. A two-layer item (…_CMYK + …_g) therefore re-routes BOTH layers; an
 * older revision of the same staff file name is superseded by its newest row
 * and is not re-routed. Rejected / review / failed rows are never re-routed.
 */
export function layersToReroute<T extends IntakeLayerRow>(rows: T[]): T[] {
  const newest = new Map<string, T>();
  const time = (row: T) => new Date(row.updatedAt || 0).getTime();
  for (const row of rows) {
    if (!REROUTABLE.has(String(row.status))) continue;
    const key = String(row.originalFilename || "").toLowerCase();
    const current = newest.get(key);
    if (!current || row.revisionNumber > current.revisionNumber || (row.revisionNumber === current.revisionNumber && time(row) > time(current))) newest.set(key, row);
  }
  return [...newest.values()].sort((a, b) => String(a.originalFilename).localeCompare(String(b.originalFilename)));
}

/** All layers of one reprint share ONE reprint number, so their run tokens match at the press. */
export function nextReprintNumber(rows: IntakeLayerRow[]): number {
  return Math.max(0, ...rows.map((row) => Number(row.reprintNumber) || 0)) + 1;
}

/* ---------------- files expected / received (display) ---------------- */

/** Layer files a finish needs, in the shop's own words. Mirrors the routing rules; display only. */
export function expectedLayersForFinish(finish: unknown): string[] {
  const text = String(finish || "").toLowerCase();
  const layers = ["CMYK"];
  if (/white/.test(text)) layers.push("White");
  if (/gloss/.test(text)) layers.push("Gloss");
  return layers;
}

export type ItemFileState = { expected: string[]; received: number; label: string; awaiting: boolean };

export function itemFileState(item: { id?: string; itemTicket?: string | null; selectedFinish?: string | null }, files: any[]): ItemFileState {
  const expected = expectedLayersForFinish(item.selectedFinish);
  const ticket = String(item.itemTicket || "").toUpperCase();
  const received = (files || []).filter((file) => {
    if (String(file?.fileType || "") !== "print_file" || String(file?.assetSource || "") !== "nas") return false;
    if (file.productionJobItemId) return String(file.productionJobItemId) === String(item.id || "");
    // rows written before the item link existed carry the ticket in the routed name
    return Boolean(ticket) && String(file.fileName || "").toUpperCase().startsWith(ticket);
  }).length;
  const awaiting = received === 0;
  return {
    expected,
    received,
    awaiting,
    label: awaiting ? `Awaiting files — ${expected.join(" + ")} expected` : `${received} print file(s) received — ${expected.join(" + ")} expected`,
  };
}
