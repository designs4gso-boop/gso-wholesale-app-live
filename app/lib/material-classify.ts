// Shared print-vs-blank material classifier, extracted verbatim from
// Product Setup (Patch 7B.1) so the Cost Calculator and Product Setup can
// never drift apart. materialType is a free string in real data (e.g. seeded
// "blank_jars"), so the split keyword-matches type hints and falls back to
// base unit. Client-safe: pure string logic, no Prisma, no server imports.
const EXCLUDED_MATERIAL_TYPE_HINT = /(ink|labor|machine)/;
const PRINT_MATERIAL_TYPE_HINT = /(label|dtp|laminate|banner|media|vinyl|roll)/;
const BLANK_MATERIAL_TYPE_HINT = /(blank|jar|bag|box|pouch)/;

export type MaterialKind = "print" | "blank" | "other" | "excluded";

export function materialKind(material: any): MaterialKind {
  const type = String(material?.materialType || "").toLowerCase();
  const baseUnit = String(material?.baseUnit || material?.unit || "").toLowerCase();

  if (EXCLUDED_MATERIAL_TYPE_HINT.test(type)) return "excluded";
  if (baseUnit === "sqft" || baseUnit === "sqin" || PRINT_MATERIAL_TYPE_HINT.test(type)) return "print";
  if (BLANK_MATERIAL_TYPE_HINT.test(type) || baseUnit === "each") return "blank";
  return "other";
}

export function materialKindLabel(material: any) {
  const kind = materialKind(material);
  if (kind === "print") return "Print media";
  if (kind === "blank") return "Blank item";
  return "Other";
}
