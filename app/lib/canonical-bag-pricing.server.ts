// Phase 15G.2 — canonical 4x5 stock-bag pricing for admin preview surfaces
// (Pricing Rules preview + Configurator admin). ONE resolution of DB inputs,
// then the SAME engines the Cost Calculator uses: computeProductDrivenCost +
// computeCommercialPrice with the resolved ownerConfig policy. Fail-closed:
// when a canonical input cannot be resolved the preview says so — it never
// substitutes hardcoded costs.

import { classifyCalculatorProduct, computeProductDrivenCost, bagSizeToken, DOCUMENTED_PRINTER_SQFT_PER_HOUR } from "./product-driven-costing.server";
import { computeCommercialPrice, marginCurveKeyFor, specialtyFinishReasons, type PricingPolicyValues } from "./commercial-pricing-policy.server";
import { resolveMarginFamily } from "./calculator-emergency.server";
import { resolvePrintMaterialCostPerSqft } from "./cost-calculator.server";
import { OWNER_STANDARDS } from "./owner-standards";
import { resolvePricingPolicyConfig } from "./owner-config.server";

export type CanonicalBagInputs = {
  available: boolean;
  reasons: string[];
  matte: { name: string; costPerSqft: number } | null;
  holographic: { name: string; costPerSqft: number } | null;
  blank: { name: string; unitCost: number | null; tiers: Array<{ minQty: number; maxQty: number | null; unitCost: number }> } | null;
  rolandSqftPerHour: number;
  policyValues: PricingPolicyValues;
};

export async function resolveCanonicalBagInputs(db: any, shop: string): Promise<CanonicalBagInputs> {
  const [materials, vendorProducts, rolandMachine, policy] = await Promise.all([
    db.material.findMany({ where: { shop, active: true, useInRecipes: true }, take: 200 }),
    db.vendorProduct.findMany({ where: { shop, active: true }, include: { tiers: { orderBy: { minQty: "asc" } } }, take: 200 }),
    db.machine.findFirst({ where: { shop, active: true, name: { contains: "Roland" } }, select: { sqftPerHour: true } }),
    resolvePricingPolicyConfig(db, shop),
  ]);

  const reasons: string[] = [];
  const materialFor = (pattern: RegExp) => {
    const candidates = materials.filter((material: any) => pattern.test(String(material.name || "")));
    for (const candidate of candidates) {
      const resolved = resolvePrintMaterialCostPerSqft(candidate);
      if (resolved.unitCost > 0) {
        return { name: String(candidate.name), costPerSqft: resolved.unitCost };
      }
    }
    return null;
  };

  const matte = materialFor(/poseidon/i) || materialFor(/matte/i);
  if (!matte) reasons.push("No verified matte print material found (Poseidon/matte with a usable unit cost).");
  const holographic = materialFor(/holo/i);

  const bagRecord = vendorProducts.find((record: any) => {
    const klass = classifyCalculatorProduct({ name: record.name, productType: record.productType, vendor: record.vendor, vendorSku: record.vendorSku });
    return klass.klass === "bag_sticker" && bagSizeToken(String(record.name || "")) === "4x5";
  });
  const bagMaterial = materials.find((material: any) => /bag/i.test(String(material.name || "")) && bagSizeToken(String(material.name || "")) === "4x5");
  const blank = bagRecord
    ? {
        name: String(bagRecord.name),
        unitCost: Number(bagRecord.defaultUnitCost) > 0 ? Number(bagRecord.defaultUnitCost) : null,
        tiers: (bagRecord.tiers || []).map((tier: any) => ({ minQty: Number(tier.minQty || 1), maxQty: tier.maxQty == null ? null : Number(tier.maxQty), unitCost: Number(tier.unitCost || 0) })),
      }
    : bagMaterial
      ? {
          name: String(bagMaterial.name),
          unitCost: Number(bagMaterial.calculatedUnitCost) > 0 ? Number(bagMaterial.calculatedUnitCost) : Number(bagMaterial.costPerUnit) > 0 ? Number(bagMaterial.costPerUnit) : null,
          tiers: [],
        }
      : null;
  if (!blank || (blank.unitCost == null && !blank.tiers.length)) reasons.push("No verified 4x5 blank bag cost found (Vendor Product or Material).");

  return {
    available: reasons.length === 0,
    reasons,
    matte,
    holographic,
    blank,
    rolandSqftPerHour: Number(rolandMachine?.sqftPerHour) > 0 ? Number(rolandMachine?.sqftPerHour) : DOCUMENTED_PRINTER_SQFT_PER_HOUR,
    policyValues: policy.values,
  };
}

export type CanonicalBagJobResult =
  | { available: false; reasons: string[] }
  | {
      available: true;
      totalCost: number;
      unitCost: number;
      recommendedTotalPrice: number;
      recommendedUnitPrice: number;
      marginPctApplied: number;
      controllingRule: string;
      blockers: string[];
    };

// Same engine call shape the Cost Calculator's product-driven path uses for
// a 4x5 sticker-applied bag (labels applied, square-rect cut, provisional
// 10% waste, standard packing rule).
export function canonicalStockBagJob(
  inputs: CanonicalBagInputs,
  options: { quantity: number; faces: number; glossLayers?: number; whiteLayers?: number; holographic?: boolean },
): CanonicalBagJobResult {
  if (!inputs.available || !inputs.blank) return { available: false, reasons: inputs.reasons.length ? inputs.reasons : ["Canonical bag inputs unavailable."] };
  const material = options.holographic ? inputs.holographic : inputs.matte;
  if (!material) return { available: false, reasons: [options.holographic ? "No verified holographic material." : "No verified matte material."] };

  const glossLayers = Math.max(0, Math.floor(options.glossLayers || 0));
  const whiteLayers = Math.max(0, Math.floor(options.whiteLayers || 0));
  const printer: "mimaki" | "roland" = glossLayers > 0 || whiteLayers > 0 || options.holographic ? "roland" : "mimaki";

  const run = computeProductDrivenCost({
    family: "bags-4x5",
    quantity: options.quantity,
    designs: 1,
    facesPerUnit: Math.max(1, Math.floor(options.faces)),
    widthIn: 4,
    heightIn: 5,
    labelRows: null,
    dtp: null,
    blank: { name: inputs.blank.name, unitCost: inputs.blank.unitCost, tiers: inputs.blank.tiers, status: "verified" },
    lid: null,
    material: { name: material.name, costPerSqft: material.costPerSqft },
    printer,
    printerHasWhite: true,
    printerHasGloss: printer === "roland",
    whiteLayers,
    glossLayers,
    glossCoveragePct: null,
    inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0,
    machineSqftPerHour: printer === "roland" ? inputs.rolandSqftPerHour : 0,
    machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: null,
    cutRequiresWeeding: false,
    hemming: false,
    grommets: false,
    freightPerUnit: 0,
    freightSource: "estimated",
    recipeWastePct: null,
    wasteOverride: null,
    boxOverride: null,
  });

  const marginRule = resolveMarginFamily("bags-4x5");
  const commercial = computeCommercialPrice({
    familyKey: "sticker-bags",
    quantity: options.quantity,
    completeCost: run.totalCost,
    marginRule,
    premiumEligible: false,
    finishedSqft: run.derived.baseSqft,
    setupTotal: run.setupTotal,
    policyValues: inputs.policyValues,
    marginCurveKey: marginCurveKeyFor("bags-4x5", Math.max(1, Math.floor(options.faces))),
    marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers, glossLayers, materialName: material.name }),
    // 15G.4C parity with the calculator route: specialty commercial tiers.
    specialty: {
      glossLayers,
      decorativeWhiteLayers: options.holographic ? 0 : whiteLayers,
      requiredWhite: Boolean(options.holographic && whiteLayers > 0),
      holographic: Boolean(options.holographic),
    },
  });

  return {
    available: true,
    totalCost: run.totalCost,
    unitCost: run.unitCost,
    recommendedTotalPrice: commercial.finalTotalPrice,
    recommendedUnitPrice: commercial.finalUnitPrice,
    marginPctApplied: commercial.marginPctApplied,
    controllingRule: commercial.controllingRule,
    blockers: run.missing,
  };
}
