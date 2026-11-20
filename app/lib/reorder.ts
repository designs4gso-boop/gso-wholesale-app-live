// 2026-11-19 — reorders (shared model). Pure, client-safe, no Prisma.
//
// A reorder is a NEW sale:
//     earlier item -> new quote -> (normal production release) -> new job -> new item tickets
// with an explicit link back to the earlier item. It is never a reprint, never
// inferred from customer or product similarity, and it never copies the
// earlier selling price: a recipe line is priced again by the current pricing
// engine for the NEW quantity; any other line is saved PROVISIONAL (owner
// approval required) with no price. The earlier job is not touched.

import { staffManualItemAuthority } from "./quote-staff-visibility";

export const REORDER_ARTWORK_MODES = [
  { value: "same_artwork", label: "Same artwork — reuse the approved file" },
  { value: "revision", label: "Revised artwork — new proof approval needed" },
] as const;
export type ReorderArtworkMode = (typeof REORDER_ARTWORK_MODES)[number]["value"];

export const REORDER_MAX_LINES = 50;
export const REORDER_PRICING_REQUIRED = "reorder_current_pricing_required";

export type ReorderLine = { itemId: string; quantity: number; artworkMode: ReorderArtworkMode };

export function isReorderArtworkMode(value: unknown): value is ReorderArtworkMode {
  return REORDER_ARTWORK_MODES.some((mode) => mode.value === value);
}

/** The posted reorder request. Every line names the earlier item, a new quantity and the artwork choice. */
export function parseReorderRequest(raw: unknown): { ok: true; lines: ReorderLine[] } | { ok: false; reason: string } {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return { ok: false, reason: "Pick at least one earlier item to reorder." };
  if (list.length > REORDER_MAX_LINES) return { ok: false, reason: `A reorder can hold at most ${REORDER_MAX_LINES} items.` };
  const lines: ReorderLine[] = [];
  const seen = new Set<string>();
  for (const entry of list as any[]) {
    const itemId = String(entry?.itemId || "").trim();
    if (!itemId) return { ok: false, reason: "A reorder line is missing its earlier item." };
    if (seen.has(itemId)) return { ok: false, reason: "The same earlier item was picked twice." };
    seen.add(itemId);
    const quantityText = String(entry?.quantity ?? "").trim().replace(/,/g, "");
    if (!/^\d+$/.test(quantityText) || Number(quantityText) < 1) return { ok: false, reason: "Enter the new quantity for every reorder item (a whole number, 1 or more)." };
    if (!isReorderArtworkMode(entry?.artworkMode)) return { ok: false, reason: "Choose same artwork or revised artwork for every reorder item." };
    lines.push({ itemId, quantity: Number(quantityText), artworkMode: entry.artworkMode });
  }
  return { ok: true, lines };
}

export type ReorderSource = {
  item: {
    id: string;
    itemTicket?: string | null;
    productTitle: string;
    variantTitle?: string | null;
    sku?: string | null;
    quantity: number;
    recipeId?: string | null;
    recipeName?: string | null;
    selectedFinish?: string | null;
    selectedAddOns?: string | null;
    productImageUrl?: string | null;
    shopifyProductGid?: string | null;
    shopifyVariantGid?: string | null;
  };
  job: { id: string; jobTicket?: string | null; customerName?: string | null; company?: string | null; email?: string | null; phone?: string | null };
};

/** A recipe line as the current pricing engine returned it for the NEW quantity (priceRecipeLine().line). */
export type CurrentPricedLine = Record<string, any>;

const customerKey = (job: ReorderSource["job"]) => `${String(job.company || "").trim().toLowerCase()}|${String(job.customerName || "").trim().toLowerCase()}|${String(job.email || "").trim().toLowerCase()}`;

export type ReorderQuoteDraft = {
  customerName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string;
  items: Array<Record<string, any>>;
  provisionalCount: number;
};

/**
 * The draft quote a reorder creates. `pricedByItemId` holds the CURRENT price
 * for the new quantity where the pricing engine could give one; a line without
 * it is provisional. The earlier unit price / cost are never read here.
 */
export function buildReorderQuoteDraft(
  sources: ReorderSource[],
  lines: ReorderLine[],
  pricedByItemId: Map<string, CurrentPricedLine>,
  actor: string,
  at: string,
): { ok: true; draft: ReorderQuoteDraft } | { ok: false; reason: string } {
  const byId = new Map(sources.map((source) => [String(source.item.id), source]));
  const picked: Array<{ line: ReorderLine; source: ReorderSource }> = [];
  for (const line of lines) {
    const source = byId.get(line.itemId);
    if (!source) return { ok: false, reason: "An earlier item was not found. Reload the page and try again." };
    picked.push({ line, source });
  }
  if (new Set(picked.map((entry) => customerKey(entry.source.job))).size > 1) return { ok: false, reason: "Reorder one customer at a time — the picked items belong to different customers." };
  const first = picked[0].source.job;
  let provisionalCount = 0;
  const items = picked.map(({ line, source }) => {
    const ticket = source.item.itemTicket || source.item.productTitle;
    const lineage = { reorderSourceItemId: String(source.item.id), reorderArtworkMode: line.artworkMode };
    const reorderNote = `Reorder of ${ticket} (earlier quantity ${source.item.quantity}) — ${line.artworkMode === "revision" ? "REVISED ARTWORK: new proof approval required" : "same artwork: reuse the approved file"}.`;
    const priced = pricedByItemId.get(String(source.item.id));
    if (priced) {
      return { ...priced, quantity: String(line.quantity), notes: [reorderNote, String(priced.notes || "")].filter(Boolean).join(" "), ...lineage };
    }
    provisionalCount += 1;
    return {
      productName: source.item.productTitle || "Custom item",
      variant: source.item.variantTitle || "",
      sku: source.item.sku || "",
      quantity: String(line.quantity),
      // No current price is available from the pricing engine: the line is PROVISIONAL
      // (owner approval required). The earlier selling price is deliberately not copied.
      unitPrice: "0",
      unitCost: "0",
      notes: `${reorderNote} Current price required — the earlier price was not copied.`,
      productImageUrl: source.item.productImageUrl || "",
      shopifyProductGid: source.item.shopifyProductGid || "",
      shopifyVariantGid: source.item.shopifyVariantGid || "",
      recipeId: "",
      recipeName: "",
      selectedFinish: source.item.selectedFinish || "",
      selectedAddOnIds: "",
      pricingSource: REORDER_PRICING_REQUIRED,
      tierLabel: "",
      minQuantity: "",
      marginPct: "",
      costSnapshot: "",
      priceSnapshot: JSON.stringify({ pricingAuthority: staffManualItemAuthority() }),
      ...lineage,
    };
  });
  const tickets = picked.map(({ source }) => source.item.itemTicket || source.item.productTitle).join(", ");
  return {
    ok: true,
    draft: {
      customerName: first.customerName || null,
      company: first.company || null,
      email: first.email || null,
      phone: first.phone || null,
      notes: `[GSO] Reorder quote created by ${actor} at ${at} from ${tickets}. New sale: current pricing for the new quantity; the earlier job is unchanged.`,
      items,
      provisionalCount,
    },
  };
}

/** One earlier item as the reorder picker shows it — never a price or a cost. */
export function toReorderOption(item: any, job: any): { itemId: string; itemTicket: string; product: string; quantity: number; finish: string; customer: string; jobTicket: string; completedAt: string | null; status: string } {
  return {
    itemId: String(item.id),
    itemTicket: String(item.itemTicket || ""),
    product: String(item.productTitle || "Item"),
    quantity: Number(item.quantity) || 0,
    finish: String(item.selectedFinish || ""),
    customer: String(job.company || job.customerName || "Customer not set"),
    jobTicket: String(job.jobTicket || ""),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    status: String(job.status || ""),
  };
}

/**
 * Saving a quote rewrites its item rows. The reorder lineage of a line that is
 * still the same row (same id) is carried over from the DATABASE; whatever the
 * browser posted in those two fields is ignored.
 */
export function withStoredReorderLineage<T extends { id?: string | null }>(item: T, stored: Array<{ id: string; reorderSourceItemId?: string | null; reorderArtworkMode?: string | null }>): T {
  const row = item.id ? stored.find((candidate) => candidate.id === item.id) : undefined;
  return { ...item, reorderSourceItemId: row?.reorderSourceItemId || null, reorderArtworkMode: row?.reorderSourceItemId ? row.reorderArtworkMode || "same_artwork" : null };
}

/**
 * 2026-11-20 — ONE reorder request -> ONE draft quote. The reorder form sends a
 * requestId; a retry, a double click or a replay after a timeout carries the
 * same id and resolves to the quote that was already created. A request with no
 * id (an older open page) is keyed on who asked for what, and only matches a
 * quote made in the last few minutes.
 */
export const REORDER_REQUEST_MARKER = "[GSO] Reorder request";
export const REORDER_AUTO_KEY_WINDOW_MINUTES = 5;

export function reorderRequestKey(requestId: unknown, fallbackParts: unknown[]): { key: string; explicit: boolean } {
  const id = String(requestId ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (id.length >= 8) return { key: id, explicit: true };
  // small stable hash (FNV-1a) of actor + lines; display-safe, not a secret
  const text = JSON.stringify(fallbackParts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return { key: `auto-${hash.toString(16).padStart(8, "0")}-${text.length}`, explicit: false };
}

export function reorderRequestMarker(key: string): string {
  return `${REORDER_REQUEST_MARKER} ${key}`;
}
