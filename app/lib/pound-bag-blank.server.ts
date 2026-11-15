// 2026-11-15 — 14x16 / Pound Bag blank cost authority.
//
// The blank cost of the 14x16 / Pound Bag is NOT a code constant. It is the
// CURRENT "14x16 Blank Bag" record:
//   1. the Vendor Cost Book record (VendorProduct) whose vendor SKU is
//      preset:pound-bag — the record Approved Cost Updates creates / maintains;
//   2. else the one active Vendor Cost Book bag record named 14x16 / Pound bag;
//   3. else the one active blank Material record with that name.
// It is read on the server for every calculation and for every save, so a
// query-string value can never set or lower it, and editing the record changes
// the next quote. No record, an ambiguous match, or a record with no cost =
// no authority: the job blocks (BAG_BLANK_COST_REQUIRED) — nothing is assumed,
// and the 4x5 / Split Bag blank costs are never borrowed.

import { blankItemUnitCostAtQty, resolveMaterialUnitCost } from "./cost-calculator.server";
import { materialKind } from "./material-classify";
import { POUND_BAG_14X16_BLANK_VENDOR_SKU } from "./bag-cost-inputs.server";

export type BagBlankCostTier = { minQty: number; maxQty: number | null; unitCost: number };

export type BagBlankAuthority = {
  recordType: "vendor_product" | "material";
  recordId: string;
  name: string;
  vendorSku: string | null;
  defaultUnitCost: number;
  tiers: BagBlankCostTier[];
  source: string;
};

/** Same name rule Approved Cost Updates uses for the 14x16 blank; a Quarter Pound (QP) bag is a different product. */
export const POUND_BAG_BLANK_NAME_PATTERN = /(14\s?x\s?16|pound)\s*(blank\s*)?bag/i;
const NOT_A_POUND_BAG = /quarter|\bqp\b|1\s*\/\s*4/i;

const isPoundBagName = (name: unknown) => POUND_BAG_BLANK_NAME_PATTERN.test(String(name || "")) && !NOT_A_POUND_BAG.test(String(name || ""));
const sku = (value: unknown) => String(value || "").trim().toLowerCase();

function fromVendorProduct(record: any, how: string): BagBlankAuthority {
  const tiers: BagBlankCostTier[] = (record.tiers || [])
    .map((tier: any) => ({ minQty: Number(tier.minQty) || 0, maxQty: tier.maxQty == null ? null : Number(tier.maxQty), unitCost: Number(tier.unitCost) || 0 }))
    .filter((tier: BagBlankCostTier) => tier.unitCost > 0);
  return {
    recordType: "vendor_product",
    recordId: String(record.id),
    name: String(record.name || "14x16 Blank Bag"),
    vendorSku: record.vendorSku ? String(record.vendorSku) : null,
    defaultUnitCost: Number(record.defaultUnitCost) || 0,
    tiers,
    source: `Vendor Cost Book record "${record.name}" (${how}) — current cost, read on the server.`,
  };
}

/** Pure: pick the 14x16 blank authority from already-loaded records. Null = no single authority. */
export function pickPoundBagBlank(vendorProducts: any[] | null | undefined, materials: any[] | null | undefined = []): BagBlankAuthority | null {
  const vendors = (vendorProducts || []).filter((record) => record && record.active !== false);
  const bySku = vendors.filter((record) => sku(record.vendorSku) === POUND_BAG_14X16_BLANK_VENDOR_SKU);
  if (bySku.length === 1) return fromVendorProduct(bySku[0], `vendor SKU ${POUND_BAG_14X16_BLANK_VENDOR_SKU}`);
  if (bySku.length > 1) return null;
  const byName = vendors.filter((record) => isPoundBagName(record.name));
  if (byName.length === 1) return fromVendorProduct(byName[0], "matched by name");
  if (byName.length > 1) return null;
  const blanks = (materials || []).filter((record) => record && record.active !== false && materialKind(record) === "blank" && isPoundBagName(record.name));
  if (blanks.length !== 1) return null;
  const resolved = resolveMaterialUnitCost(blanks[0]);
  return {
    recordType: "material",
    recordId: String(blanks[0].id),
    name: String(blanks[0].name),
    vendorSku: blanks[0].sku ? String(blanks[0].sku) : null,
    defaultUnitCost: Number(resolved.unitCost) || 0,
    tiers: [],
    source: `Material record "${blanks[0].name}" — current cost, read on the server.`,
  };
}

/** The blank unit cost at a quantity (the record's quantity tiers when it has them). Null when the record carries no cost. */
export function poundBagBlankUnitCostAt(authority: BagBlankAuthority | null | undefined, quantity: number): number | null {
  if (!authority) return null;
  const resolved = blankItemUnitCostAtQty(authority.tiers, authority.defaultUnitCost, quantity, authority.name);
  const unit = Number(resolved.unitCost);
  return Number.isFinite(unit) && unit > 0 ? unit : null;
}

export async function loadPoundBagBlank(deps: { db: any; shop: string }): Promise<BagBlankAuthority | null> {
  const vendorProducts = await deps.db.vendorProduct.findMany({
    where: { shop: deps.shop, active: true },
    include: { tiers: { orderBy: { minQty: "asc" } } },
  });
  const fromVendors = pickPoundBagBlank(vendorProducts, []);
  if (fromVendors) return fromVendors;
  // An ambiguous Vendor Cost Book match is never settled by falling through to Materials.
  const vendors = (vendorProducts || []).filter((record: any) => record && record.active !== false);
  if (vendors.some((record: any) => sku(record.vendorSku) === POUND_BAG_14X16_BLANK_VENDOR_SKU || isPoundBagName(record.name))) return null;
  const materials = await deps.db.material.findMany({ where: { shop: deps.shop, active: true } });
  return pickPoundBagBlank([], materials);
}

/** Attach the server-read 14x16 blank authority to a canonical pound-bags input (no-op for every other family). */
export async function attachPoundBagBlank<T extends { family: string; bags?: any }>(deps: { db: any; shop: string }, input: T): Promise<T> {
  if (input.family !== "pound-bags" || !input.bags) return input;
  return { ...input, bags: { ...input.bags, blankAuthority: await loadPoundBagBlank(deps) } };
}
