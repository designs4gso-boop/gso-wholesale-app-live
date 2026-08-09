import { db } from "../db.server";

export type RuleLike = {
  id: number;
  title: string;
  customerTag: string;
  scopeType: string;
  scopeId: string | null;
  scopeLabel: string | null;
  discountType: "FIXED_PRICE" | "PERCENT_OFF" | "AMOUNT_OFF";
  value: number;
  minQuantity: number;
  minProductQuantity: number | null;
  minCartQuantity: number | null;
  minSubtotal: number | null;
  priority: number;
  active: boolean;
};

export type CartContext = {
  customerTags?: string[];
  quantity: number;
  cartQuantity: number;
  subtotal: number;
  productId: string;
  variantId: string;
  collectionIds?: string[];
};

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculateUnitPrice(
  retailPrice: number,
  rule?: Pick<RuleLike, "discountType" | "value"> | null,
) {
  if (!rule) return round(retailPrice);
  if (rule.discountType === "FIXED_PRICE") return round(rule.value);
  if (rule.discountType === "PERCENT_OFF") return round(retailPrice * (1 - rule.value / 100));
  if (rule.discountType === "AMOUNT_OFF") return round(Math.max(0, retailPrice - rule.value));
  return round(retailPrice);
}

function scopePriority(scopeType: string) {
  switch (scopeType) {
    case "VARIANT": return 10;
    case "PRODUCT": return 20;
    case "COLLECTION": return 30;
    case "GLOBAL": return 40;
    default: return 100;
  }
}

export async function getWholesaleConfig(shop: string) {
  const found = await db.shopSettings.findUnique({
    where: { shop },
    include: {
      rules: { orderBy: [{ active: "desc" }, { priority: "asc" }, { minQuantity: "asc" }] },
      applications: { orderBy: { createdAt: "desc" } },
    },
  });

  if (found) return found;

  return db.shopSettings.create({
    data: { shop },
    include: { rules: true, applications: true },
  });
}

export async function saveWholesaleConfig(
  shop: string,
  payload: {
    wholesaleTag: string;
    pendingTag: string;
    vipTag: string;
    storewidePercentOff: number;
    minimumSubtotal: number;
    minCartQuantity: number;
    enforceMinCartQty: boolean;
    lockWholesaleAccess: boolean;
  },
) {
  return db.shopSettings.upsert({
    where: { shop },
    update: {
      wholesaleTag: payload.wholesaleTag,
      pendingTag: payload.pendingTag,
      vipTag: payload.vipTag,
      storewidePercentOff: n(payload.storewidePercentOff),
      minimumSubtotal: n(payload.minimumSubtotal),
      minCartQuantity: Math.max(1, n(payload.minCartQuantity, 1)),
      enforceMinCartQty: Boolean(payload.enforceMinCartQty),
      lockWholesaleAccess: Boolean(payload.lockWholesaleAccess),
    },
    create: {
      shop,
      wholesaleTag: payload.wholesaleTag,
      pendingTag: payload.pendingTag,
      vipTag: payload.vipTag,
      storewidePercentOff: n(payload.storewidePercentOff),
      minimumSubtotal: n(payload.minimumSubtotal),
      minCartQuantity: Math.max(1, n(payload.minCartQuantity, 1)),
      enforceMinCartQty: Boolean(payload.enforceMinCartQty),
      lockWholesaleAccess: Boolean(payload.lockWholesaleAccess),
    },
  });
}

export async function getRules(shop: string) {
  return db.wholesaleRule.findMany({
    where: { shop },
    orderBy: [{ active: "desc" }, { priority: "asc" }, { minQuantity: "asc" }],
  });
}

export async function createRule(
  shop: string,
  data: {
    title: string;
    customerTag: string;
    scopeType: string;
    scopeId?: string | null;
    scopeLabel?: string | null;
    discountType: string;
    value: number;
    minQuantity?: number;
    minProductQuantity?: number | null;
    minCartQuantity?: number | null;
    minSubtotal?: number | null;
    active?: boolean;
  },
) {
  const settings = await getWholesaleConfig(shop);

  return db.wholesaleRule.create({
    data: {
      shop,
      customerTag: data.customerTag,
      title: data.title,
      scopeType: data.scopeType,
      scopeId: data.scopeId || null,
      scopeLabel: data.scopeLabel || null,
      discountType: data.discountType,
      value: n(data.value),
      minQuantity: Math.max(1, n(data.minQuantity, 1)),
      minProductQuantity: data.minProductQuantity ? Math.max(1, n(data.minProductQuantity, 1)) : null,
      minCartQuantity: data.minCartQuantity ? Math.max(1, n(data.minCartQuantity, 1)) : null,
      minSubtotal: data.minSubtotal ? n(data.minSubtotal) : null,
      priority: scopePriority(data.scopeType),
      active: data.active !== false,
      settingsId: settings.id,
    },
  });
}

// 15G.1: WholesaleRule ids are auto-increment integers (trivially
// enumerable), so every mutation is scoped to the caller's shop and fails
// closed (count 0) when the record belongs to another shop or is unknown.
export async function updateRule(shop: string, id: number, data: any) {
  if (!shop || !Number.isFinite(id)) return { count: 0 };
  return db.wholesaleRule.updateMany({
    where: { id, shop },
    data: {
      ...data,
      priority: data.scopeType ? scopePriority(data.scopeType) : undefined,
    },
  });
}

export async function deleteRule(shop: string, id: number) {
  if (!shop || !Number.isFinite(id)) return { count: 0 };
  return db.wholesaleRule.deleteMany({ where: { id, shop } });
}

export async function createWholesaleApplication(
  shop: string,
  application: {
    customerId: string;
    email: string;
    companyName?: string;
    phone?: string;
    taxId?: string;
    resaleNumber?: string;
    notes?: string;
  },
) {
  const settings = await getWholesaleConfig(shop);

  return db.wholesaleApplication.create({
    data: {
      shop,
      customerId: application.customerId,
      email: application.email,
      companyName: application.companyName,
      phone: application.phone,
      taxId: application.taxId,
      resaleNumber: application.resaleNumber,
      notes: application.notes,
      settingsId: settings.id,
    },
  });
}

function matchesScope(rule: RuleLike, ctx: CartContext) {
  if (rule.scopeType === "GLOBAL") return true;
  if (rule.scopeType === "PRODUCT") return rule.scopeId === ctx.productId;
  if (rule.scopeType === "VARIANT") return rule.scopeId === ctx.variantId;
  if (rule.scopeType === "COLLECTION") return !!rule.scopeId && (ctx.collectionIds || []).includes(rule.scopeId);
  return false;
}

function matchesCustomerTag(rule: RuleLike, ctx: CartContext) {
  const tags = (ctx.customerTags || []).map((t) => String(t).trim().toLowerCase());
  return tags.includes(String(rule.customerTag || "").trim().toLowerCase());
}

function meetsThresholds(rule: RuleLike, ctx: CartContext) {
  if (ctx.quantity < n(rule.minQuantity, 1)) return false;
  if (rule.minProductQuantity && ctx.quantity < rule.minProductQuantity) return false;
  if (rule.minCartQuantity && ctx.cartQuantity < rule.minCartQuantity) return false;
  if (rule.minSubtotal && ctx.subtotal < rule.minSubtotal) return false;
  return true;
}

export function resolveBestRule(rules: RuleLike[], ctx: CartContext) {
  const candidates = rules
    .filter((r) => r.active)
    .filter((r) => matchesCustomerTag(r, ctx))
    .filter((r) => matchesScope(r, ctx))
    .filter((r) => meetsThresholds(r, ctx))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.minQuantity - b.minQuantity;
    });

  let best: RuleLike | null = null;
  for (const rule of candidates) best = rule;
  return best;
}

export async function getProductWholesalePricing(
  shop: string,
  productId: string,
  variantIds: string[],
  customerTags: string[] = [],
  collectionIds: string[] = [],
  subtotal = 0,
  cartQuantity = 0,
) {
  const settings = await getWholesaleConfig(shop);
  const rules = settings.rules.filter((r) => r.active);

  const tiersByVariant: Record<string, RuleLike[]> = {};
  const metaByVariant: Record<string, any> = {};

  for (const variantId of variantIds) {
    const scoped = rules
      .filter((rule) => matchesCustomerTag(rule as RuleLike, {
        customerTags,
        quantity: 1,
        cartQuantity,
        subtotal,
        productId,
        variantId,
        collectionIds,
      }))
      .filter((rule) => matchesScope(rule as RuleLike, {
        customerTags,
        quantity: 1,
        cartQuantity,
        subtotal,
        productId,
        variantId,
        collectionIds,
      }))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.minQuantity - b.minQuantity;
      });

    tiersByVariant[variantId] = scoped as RuleLike[];
    metaByVariant[variantId] = {
      minProductQuantity: scoped.reduce((acc, r) => Math.max(acc, r.minProductQuantity || 0), 0) || 1,
    };
  }

  return {
    settings,
    tiersByVariant,
    metaByVariant,
  };
}

export async function validateCart(
  shop: string,
  payload: {
    customerTags?: string[];
    subtotal: number;
    cartQuantity: number;
    lines: Array<{
      productId: string;
      variantId: string;
      quantity: number;
      collectionIds?: string[];
    }>;
  },
) {
  const settings = await getWholesaleConfig(shop);
  const rules = settings.rules.filter((r) => r.active);
  const errors: string[] = [];

  if (settings.enforceMinCartQty && payload.cartQuantity < settings.minCartQuantity) {
    errors.push(`Minimum total cart quantity is ${settings.minCartQuantity}.`);
  }

  if (settings.minimumSubtotal > 0 && payload.subtotal < settings.minimumSubtotal) {
    errors.push(`Minimum wholesale subtotal is $${settings.minimumSubtotal.toFixed(2)}.`);
  }

  for (const line of payload.lines) {
    const applicable = resolveBestRule(rules as RuleLike[], {
      customerTags: payload.customerTags || [],
      quantity: line.quantity,
      cartQuantity: payload.cartQuantity,
      subtotal: payload.subtotal,
      productId: line.productId,
      variantId: line.variantId,
      collectionIds: line.collectionIds || [],
    });

    const sameScopeRules = rules.filter((r) =>
      matchesCustomerTag(r as RuleLike, {
        customerTags: payload.customerTags || [],
        quantity: line.quantity,
        cartQuantity: payload.cartQuantity,
        subtotal: payload.subtotal,
        productId: line.productId,
        variantId: line.variantId,
        collectionIds: line.collectionIds || [],
      }) &&
      matchesScope(r as RuleLike, {
        customerTags: payload.customerTags || [],
        quantity: line.quantity,
        cartQuantity: payload.cartQuantity,
        subtotal: payload.subtotal,
        productId: line.productId,
        variantId: line.variantId,
        collectionIds: line.collectionIds || [],
      })
    );

    const lineMOQ = sameScopeRules.reduce((acc, r) => Math.max(acc, r.minProductQuantity || 0), 0);
    if (lineMOQ > 0 && line.quantity < lineMOQ) {
      errors.push(`Line ${line.variantId} requires at least ${lineMOQ} units.`);
    }

    if (applicable?.minCartQuantity && payload.cartQuantity < applicable.minCartQuantity) {
      errors.push(`Cart needs at least ${applicable.minCartQuantity} total units for rule "${applicable.title}".`);
    }

    if (applicable?.minSubtotal && payload.subtotal < applicable.minSubtotal) {
      errors.push(`Cart subtotal must be at least $${applicable.minSubtotal.toFixed(2)} for rule "${applicable.title}".`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    settings: {
      minCartQuantity: settings.minCartQuantity,
      enforceMinCartQty: settings.enforceMinCartQty,
      minimumSubtotal: settings.minimumSubtotal,
    },
  };
}

export async function syncDiscountFunction() {
  return { ok: true, skipped: true };
}

export async function syncValidationFunction() {
  return { ok: true, skipped: true };
}
