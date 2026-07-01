export type ProductFamilySalesRule = {
  key: string;
  label: string;
  aliases: string[];
  officialMoq: number | null;
  quotePrepAllowed: boolean;
  manualReviewRequired: boolean;
  agentFirmPricingAllowed: boolean;
  agentSafeStage: string;
  salesRules: string[];
  customerSafeSummary: string;
  staffNotes: string;
};

export const PRODUCT_FAMILY_SALES_RULES: ProductFamilySalesRule[] = [
  {
    key: "jars",
    label: "Jars",
    aliases: ["Jars", "Jar", "Miron Jars", "Glass Jars"],
    officialMoq: 128,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "intake_quote_prep",
    salesRules: [
      "Official MOQ: 128",
      "Quote-ready after recipe/cost review",
      "Sales/agent use only after Product Setup marks recipe Use in Quotes / CRM",
    ],
    customerSafeSummary:
      "Custom jar orders usually start at 128 units. Final pricing depends on jar type, label/application options, artwork, and review.",
    staffNotes:
      "Do not allow firm agent pricing until recipe/cost review and quote readiness are complete.",
  },
  {
    key: "sticker-bags",
    label: "Sticker Bags",
    aliases: ["Sticker Bags", "Sticker Bag", "Label Applied Bags"],
    officialMoq: 100,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "intake_quote_prep",
    salesRules: [
      "Official MOQ: 100",
      "Quote prep allowed",
      "Staff review required before firm quote/order",
    ],
    customerSafeSummary:
      "Sticker bag orders usually start at 100 units. Final pricing depends on bag size, label size, material, finish, sides, and application.",
    staffNotes:
      "Allow intake and quote prep only until recipe, margin, and quote-readiness are reviewed.",
  },
  {
    key: "dtp-pouches",
    label: "DTP Pouches",
    aliases: ["DTP Pouches", "DTP Bags", "Direct To Pouch", "Custom Mylar"],
    officialMoq: 1000,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "manual_review_required",
    salesRules: [
      "Official MOQ: 1,000",
      "Manual review required",
      "Do not allow agent firm pricing yet",
    ],
    customerSafeSummary:
      "Direct-to-pouch/custom mylar orders usually start at 1,000 units and require staff review before final quote.",
    staffNotes:
      "Do not let agents provide firm price or promise production without manual review.",
  },
  {
    key: "boxes",
    label: "Boxes",
    aliases: ["Boxes", "Tuck Boxes", "Cartons"],
    officialMoq: 1000,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "manual_review_required",
    salesRules: [
      "Official MOQ: 1,000+",
      "Manual review required",
      "Do not allow agent firm pricing yet",
    ],
    customerSafeSummary:
      "Custom box orders usually start around 1,000 units. Final pricing depends on size, board, finish, print, and structural requirements.",
    staffNotes:
      "Manual review is required before quoting or committing timeline.",
  },
  {
    key: "labels-stickers",
    label: "Labels / Stickers",
    aliases: ["Labels", "Stickers", "Die Cut Stickers", "Roll Labels"],
    officialMoq: null,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "best_first_agent_intake",
    salesRules: [
      "Quote prep allowed",
      "Review dimensions, material, finish, cut type, and margin before approval",
      "Good first product family for sales intake/quote prep",
    ],
    customerSafeSummary:
      "Labels and stickers are a good starting point for quote prep. Final quote depends on size, quantity, material, finish, cut type, and artwork.",
    staffNotes:
      "Best first product family for early sales agents, but still require review before firm pricing.",
  },
  {
    key: "banners",
    label: "Banners",
    aliases: ["Banners", "Vinyl Banners", "Wide Format"],
    officialMoq: null,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "intake_quote_prep",
    salesRules: [
      "Quote prep allowed",
      "Review square footage, material, finishing, and margin before approval",
    ],
    customerSafeSummary:
      "Banner pricing depends on size, material, finishing, grommets/pole pockets, and artwork.",
    staffNotes:
      "Allow intake and quote prep only until staff confirms specs and margin.",
  },
  {
    key: "apparel-dtf",
    label: "Apparel / DTF",
    aliases: ["Apparel", "DTF", "DTF Transfers", "Shirts", "Hoodies"],
    officialMoq: null,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "intake_quote_prep",
    salesRules: [
      "Quote prep allowed",
      "Review blank garment/transfer cost, size/color variants, labor, and margin before approval",
    ],
    customerSafeSummary:
      "Apparel and DTF pricing depends on garment type, size/color mix, artwork, print size, quantity, and labor.",
    staffNotes:
      "Do not allow firm pricing without blank/transfer cost and labor review.",
  },
  {
    key: "sourced-blank-resale",
    label: "Sourced / Blank Resale",
    aliases: ["Sourced", "Blank Resale", "Blank Bags", "Resale"],
    officialMoq: null,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "manual_review_required",
    salesRules: [
      "Vendor MOQ / case pack controls",
      "Manual review required",
    ],
    customerSafeSummary:
      "Sourced or blank resale items depend on supplier MOQ, case pack, availability, and shipping.",
    staffNotes:
      "Agents can collect requirements only. Staff must verify vendor availability and cost.",
  },
  {
    key: "custom-other",
    label: "Custom / Other",
    aliases: ["Custom", "Other", "Unknown"],
    officialMoq: null,
    quotePrepAllowed: false,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "intake_only",
    salesRules: [
      "Intake only",
      "Manual review required before quote",
    ],
    customerSafeSummary:
      "Custom requests need staff review before pricing or production details are confirmed.",
    staffNotes:
      "Use only for intake triage.",
  },
  {
    key: "die-cut-shaped-bags",
    label: "Die-cut / Shaped Bags",
    aliases: ["Die Cut Bags", "Die-cut Bags", "Shaped Bags", "Custom Shape Bags"],
    officialMoq: 2500,
    quotePrepAllowed: true,
    manualReviewRequired: true,
    agentFirmPricingAllowed: false,
    agentSafeStage: "manual_review_required",
    salesRules: [
      "Official MOQ: 2,500",
      "Manual review required",
      "Do not allow agent firm pricing yet",
    ],
    customerSafeSummary:
      "Custom die-cut or shaped bag orders usually start at 2,500 units and require staff review for tooling, shape, material, and pricing.",
    staffNotes:
      "Agents can collect specs only. Staff must review tooling, die cost, shape, material, and timeline.",
  },
];

function normalize(value: string) {
  return String(value || "").trim().toLowerCase();
}

export function allProductFamilySalesRules(): ProductFamilySalesRule[] {
  return PRODUCT_FAMILY_SALES_RULES;
}

export function productFamilySalesRuleFor(value: string): ProductFamilySalesRule {
  const text = normalize(value);
  const exact = PRODUCT_FAMILY_SALES_RULES.find((rule) => {
    return (
      normalize(rule.key) === text ||
      normalize(rule.label) === text ||
      rule.aliases.some((alias) => normalize(alias) === text)
    );
  });
  if (exact) return exact;

  if (text.includes("jar")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "jars")!;
  if (text.includes("sticker") && text.includes("bag")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "sticker-bags")!;
  if (text.includes("dtp") || text.includes("pouch")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "dtp-pouches")!;
  if (text.includes("box")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "boxes")!;
  if (text.includes("label") || text.includes("sticker")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "labels-stickers")!;
  if (text.includes("banner")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "banners")!;
  if (text.includes("apparel") || text.includes("dtf") || text.includes("shirt") || text.includes("hoodie")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "apparel-dtf")!;
  if (text.includes("sourced") || text.includes("blank") || text.includes("resale")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "sourced-blank-resale")!;
  if (text.includes("die") || text.includes("shape")) return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "die-cut-shaped-bags")!;

  return PRODUCT_FAMILY_SALES_RULES.find((rule) => rule.key === "custom-other")!;
}

export function salesRulesForFamily(value: string): string[] {
  return productFamilySalesRuleFor(value).salesRules;
}

export function officialMoqForFamily(value: string): number | null {
  return productFamilySalesRuleFor(value).officialMoq;
}
