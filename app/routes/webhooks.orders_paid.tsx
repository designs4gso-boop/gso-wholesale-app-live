import { authenticate } from "../shopify.server";
import db from "../db.server";

const defaultChecklist = [
  { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
  { section: "prepress", label: "Dieline / size confirmed", sortOrder: 20 },
  { section: "prepress", label: "Proof sent if required", sortOrder: 30 },
  { section: "prepress", label: "Proof approved", sortOrder: 40 },
  { section: "production", label: "Material pulled", sortOrder: 50 },
  { section: "production", label: "Machine assigned", sortOrder: 60 },
  { section: "production", label: "Print complete", sortOrder: 70 },
  { section: "production", label: "Cut / laminate / finish complete", sortOrder: 80 },
  { section: "qc", label: "QC passed", sortOrder: 90 },
  { section: "packing", label: "Packed and labeled", sortOrder: 100 },
];

function clean(value: any) {
  return String(value ?? "").trim();
}

function money(value: any) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function dateStamp(value = new Date()) {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}

function slugPart(value: any, fallback = "JOB") {
  const cleanValue = String(value || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  return cleanValue || fallback;
}

async function buildNextJobTicket(shop: string, now = new Date()) {
  const stamp = dateStamp(now);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const countToday = await db.productionJob.count({
    where: { shop, createdAt: { gte: start, lt: end } },
  });

  for (let sequence = countToday + 1; sequence < countToday + 5000; sequence += 1) {
    const ticket = `GSO-${stamp}-${String(sequence).padStart(4, "0")}`;
    const existing = await db.productionJob.findFirst({ where: { shop, jobTicket: ticket } });
    if (!existing) return ticket;
  }

  return `GSO-${stamp}-${String(Date.now()).slice(-6)}`;
}

function itemTicketFor(jobTicket: string, index: number) {
  return `${jobTicket}-${String(index + 1).padStart(2, "0")}`;
}

function normalizeFilePart(value: any, fallback = "ITEM") {
  return slugPart(value || fallback, fallback).slice(0, 40);
}

function suggestedFileNameForItem(jobTicket: string, item: any, index: number) {
  const ticket = itemTicketFor(jobTicket, index);
  const product = normalizeFilePart(item.productTitle || item.title || "PRODUCT");
  const finish = normalizeFilePart(item.productionFinish || item.finish || "FINISH");
  const isJar = isJarFamily(item.productFamily) || String(item.productType || "").startsWith("jar_");
  const color = normalizeFilePart(isJar ? item.labelSet || "LABEL" : item.bagColor || "COLOR");
  const qty = Number(item.quantity || 1);

  if (isJar && item.jarColor) {
    const jarColor = normalizeFilePart(item.jarColor);
    return `${ticket}_${product}_${finish}_${jarColor}_${color}_QTY${qty}`;
  }

  return `${ticket}_${product}_${finish}_${color}_QTY${qty}`;
}

function gid(type: string, value: any) {
  const raw = clean(value);
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/${type}/${raw}`;
}

function orderIdentity(order: any) {
  return clean(order.admin_graphql_api_id) || gid("Order", order.id) || clean(order.id);
}

function orderName(order: any) {
  return clean(order.name) || clean(order.order_number) || clean(order.id) || "Shopify Order";
}

function getLineProperty(line: any, name: string) {
  const wanted = name.toLowerCase();

  const properties = Array.isArray(line.properties) ? line.properties : [];
  for (const prop of properties) {
    const key = clean(prop.name || prop.key).toLowerCase();
    if (key === wanted) return clean(prop.value);
  }

  const customAttributes = Array.isArray(line.customAttributes) ? line.customAttributes : [];
  for (const attr of customAttributes) {
    const key = clean(attr.name || attr.key).toLowerCase();
    if (key === wanted) return clean(attr.value);
  }

  return "";
}

function isJarFamily(value: any) {
  const family = clean(value).toLowerCase();
  return family === "jars" || family === "jar";
}

function lineProductFamily(line: any) {
  return getLineProperty(line, "Product Family");
}

function lineProductType(line: any) {
  return getLineProperty(line, "Product Type");
}

function lineLabelSet(line: any) {
  return getLineProperty(line, "Label Set");
}

function lineJarColor(line: any) {
  return getLineProperty(line, "Jar Color");
}

function isConfiguratorLine(line: any) {
  const material = getLineProperty(line, "Material");
  const finish = getLineProperty(line, "Finish");
  const bagColor = getLineProperty(line, "Bag Color");
  const productFamily = lineProductFamily(line);
  const labelSet = lineLabelSet(line);

  return Boolean(
    (material && finish && bagColor) ||
      (isJarFamily(productFamily) && material && finish && labelSet),
  );
}

function customerName(order: any) {
  const first = clean(order.customer?.first_name || order.billing_address?.first_name);
  const last = clean(order.customer?.last_name || order.billing_address?.last_name);
  const joined = `${first} ${last}`.trim();

  return joined || clean(order.billing_address?.name) || clean(order.email) || "Shopify customer";
}

function companyName(order: any) {
  return clean(order.billing_address?.company) || clean(order.customer?.default_address?.company) || "";
}

function lineProductTitle(line: any) {
  const title = clean(line.title || line.name);
  if (!title) return "Configured Stock Bag";
  return title.replace(/\s+-\s+[^-]+\/[^-]+\/[^-]+$/i, "");
}

async function createProductionJobFromConfiguratorOrder(shop: string, order: any) {
  const orderId = orderIdentity(order);
  const quoteId = `shopify_order_${orderId || clean(order.id) || Date.now()}`;
  const quoteNumber = orderName(order);

  const configuredLines = (Array.isArray(order.line_items) ? order.line_items : []).filter(isConfiguratorLine);

  if (!configuredLines.length) {
    return { created: false, reason: "No configurator line items found." };
  }

  const existingJob = await db.productionJob.findFirst({
    where: { shop, quoteId },
  });

  if (existingJob) {
    return { created: false, reason: "Production job already exists.", job: existingJob };
  }

  const jobTicket = await buildNextJobTicket(shop);
  const firstLine = configuredLines[0];
  const customer = customerName(order);
  const company = companyName(order);

  const mappedItems = configuredLines.map((line: any, index: number) => {
    const productFamily = lineProductFamily(line);
    const productType = lineProductType(line);
    const material = getLineProperty(line, "Material");
    const finish = getLineProperty(line, "Finish");
    const productionFinish = getLineProperty(line, "Production Finish") || finish;
    const bagColor = getLineProperty(line, "Bag Color");
    const labelSet = lineLabelSet(line);
    const jarColor = lineJarColor(line);
    const sides = getLineProperty(line, "Sides") || "Double Sided";
    const isJar = isJarFamily(productFamily) || productType.startsWith("jar_");
    const quantity = Number(line.quantity || 1);
    const unitPrice = money(line.price || line.originalUnitPrice || line.original_unit_price || 0);
    const productTitle = lineProductTitle(line);
    const variantTitle = isJar
      ? [jarColor, material, finish, labelSet].filter(Boolean).join(" / ")
      : `${material} / ${finish} / ${bagColor}`;
    const selectedAddOns = isJar
      ? {
          productFamily,
          productType,
          material,
          finish,
          productionFinish,
          ...(jarColor ? { jarColor } : {}),
          labelSet,
        }
      : {
          productFamily,
          productType,
          material,
          finish,
          productionFinish,
          bagColor,
          sides,
        };
    const materialSummary = isJar
      ? [
          `Product Family: ${productFamily}`,
          `Product Type: ${productType}`,
          `Material: ${material}`,
          `Finish: ${finish}`,
          `Production Finish: ${productionFinish}`,
          ...(jarColor ? [`Jar Color: ${jarColor}`] : []),
          `Label Set: ${labelSet}`,
        ].join(" | ")
      : `Material: ${material} | Finish: ${finish} | Production Finish: ${productionFinish} | Bag Color: ${bagColor} | Sides: ${sides}`;
    const productionNotes = isJar
      ? [
          `Shopify order: ${quoteNumber}`,
          `Product Family: ${productFamily}`,
          `Product Type: ${productType}`,
          `Material: ${material}`,
          `Finish: ${finish}`,
          `Production Finish: ${productionFinish}`,
          ...(jarColor ? [`Jar Color: ${jarColor}`] : []),
          `Label Set: ${labelSet}`,
        ].join("\n")
      : [
          `Shopify order: ${quoteNumber}`,
          `Material: ${material}`,
          `Finish: ${finish}`,
          `Production Finish: ${productionFinish}`,
          `Bag Color: ${bagColor}`,
          `Sides: ${sides}`,
        ].join("\n");

    const priceSnapshot = {
      source: "shopify_order_paid_webhook",
      orderId,
      orderName: quoteNumber,
      lineItemId: line.id || null,
      productFamily,
      productType,
      material,
      finish,
      productionFinish,
      bagColor,
      ...(jarColor ? { jarColor } : {}),
      labelSet,
      sides,
      quantity,
      unitPrice,
      lineTotal: money(unitPrice * quantity),
    };

    const item = {
      productTitle,
      variantTitle,
      sku: clean(line.sku) || null,
      quantity,
      unitPrice,
      unitCost: 0,
      shopifyProductGid: gid("Product", line.product_id),
      shopifyVariantGid: gid("ProductVariant", line.variant_id),
      productImageUrl:
        getLineProperty(line, "_GSO Product Image") ||
        getLineProperty(line, "Product Image") ||
        clean(line.image?.src || line.image?.url || line.variant?.image?.src || line.variant?.image?.url || "") ||
        null,
      selectedFinish: productionFinish,
      selectedAddOns: JSON.stringify(selectedAddOns),
      materialSummary,
      priceSnapshot: JSON.stringify(priceSnapshot),
      costSnapshot: JSON.stringify({
        source: "pending_cost_book_mapping",
        note: "Customer price captured from Shopify order. Internal cost will be mapped from Material Center / Cost Book later.",
      }),
      productionNotes,
      sortOrder: index + 1,
    };

    return {
      ...item,
      itemTicket: itemTicketFor(jobTicket, index),
      ripJobName: itemTicketFor(jobTicket, index),
      suggestedFileName: suggestedFileNameForItem(jobTicket, { productTitle: item.productTitle, productFamily, productType, productionFinish: line.productionFinish || productionFinish, finish: line.finish || finish, bagColor: line.bagColor || bagColor, jarColor: line.jarColor || jarColor, labelSet: line.labelSet || labelSet, quantity: item.quantity }, index),
    };
  });

  const firstImage =
    getLineProperty(firstLine, "_GSO Product Image") ||
    getLineProperty(firstLine, "Product Image") ||
    clean(firstLine.image?.src || firstLine.image?.url || firstLine.variant?.image?.src || firstLine.variant?.image?.url || "") ||
    mappedItems.find((item) => item.productImageUrl)?.productImageUrl ||
    null;

  const job = await db.productionJob.create({
    data: {
      shop,
      quoteId,
      quoteNumber,
      jobTicket,
      assetInboxKey: jobTicket,
      customerName: customer,
      company: company || null,
      email: clean(order.email || order.customer?.email) || null,
      phone: clean(order.phone || order.billing_address?.phone || order.customer?.phone) || null,
      status: "new",
      priority: "normal",
      customerNotes: clean(order.note) || null,
      internalNotes: `Created automatically from paid Shopify configurator order ${quoteNumber}.`,
      productImageUrl: firstImage,
      items: {
        create: mappedItems.map((item) => ({
          shop,
          ...item,
        })),
      },
      checklistItems: {
        create: defaultChecklist.map((check) => ({ shop, ...check })),
      },
      events: {
        create: [
          {
            shop,
            eventType: "created_from_shopify_order",
            message: `Production job ${jobTicket} created from paid Shopify configurator order ${quoteNumber}.`,
          },
        ],
      },
    },
    include: { items: true },
  });

  return { created: true, reason: "Production job created from configurator order.", job };
}

const DEPOSIT_PAID_MARKER = "[GSO] Deposit invoice paid";
const BALANCE_PAID_MARKER = "[GSO] Balance invoice paid";
const FULL_PAID_MARKER = "[GSO] Full payment invoice paid";

function orderTags(order: any) {
  const raw = order?.tags;
  const parts = Array.isArray(raw) ? raw.map((tag: any) => clean(tag)) : clean(raw).split(",");
  return parts.map((tag: string) => tag.trim().toLowerCase()).filter(Boolean);
}

function classifyQuotePaymentOrder(order: any, note: string) {
  const tags = orderTags(order);
  const noteText = note.toLowerCase();
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];

  const isDeposit =
    tags.includes("deposit") ||
    noteText.includes("deposit created from gso quote builder") ||
    lines.some((line: any) => getLineProperty(line, "Deposit Percent") || clean(line.title).startsWith("Deposit Payment"));

  const isBalance =
    tags.includes("remaining balance") ||
    noteText.includes("remaining balance created from gso quote builder") ||
    lines.some((line: any) => getLineProperty(line, "Deposit Paid") || clean(line.title).startsWith("Remaining Balance"));

  if (isDeposit && isBalance) return "unknown";
  if (isDeposit) return "deposit";
  if (isBalance) return "balance";

  // "created from gso quote builder" also appears inside the deposit/balance notes,
  // so the full-payment check must run after both of them.
  if (tags.includes("full payment") || noteText.includes("created from gso quote builder")) return "full";

  return "unknown";
}

function appendQuoteNote(notes: string | null | undefined, line: string) {
  const existing = String(notes || "");
  if (existing.includes(line)) return existing;
  return existing ? `${existing}\n${line}` : line;
}

async function applyQuotePaymentFromOrder(shop: string, quoteId: string, order: any, note: string) {
  const quote = await db.quote.findFirst({ where: { id: quoteId, shop } });
  if (!quote) return "OK no matching quote for Quote ID";

  const paymentType = classifyQuotePaymentOrder(order, note);
  const orderLabel = orderName(order);
  const existingNotes = String(quote.notes || "");
  const depositAlreadyPaid =
    quote.status === "deposit_paid" || quote.status === "paid" || existingNotes.includes(DEPOSIT_PAID_MARKER);
  const balanceAlreadyPaid = quote.status === "paid" || existingNotes.includes(BALANCE_PAID_MARKER);

  if (paymentType === "full") {
    await db.quote.updateMany({
      where: { id: quote.id, shop },
      data: {
        status: "paid",
        notes: appendQuoteNote(quote.notes, `${FULL_PAID_MARKER} (Shopify order ${orderLabel}).`),
      },
    });
    return "OK quote marked paid (full payment)";
  }

  if (paymentType === "deposit") {
    const notes = appendQuoteNote(quote.notes, `${DEPOSIT_PAID_MARKER} (Shopify order ${orderLabel}).`);

    if (balanceAlreadyPaid) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "paid", notes } });
      return "OK quote marked paid (deposit and balance both paid)";
    }

    // Deposit payment must never present as full settlement, and must not pull a
    // quote backward out of a later workflow status.
    if (["paid", "production", "completed"].includes(quote.status)) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { notes } });
      return `OK deposit payment recorded; status ${quote.status} preserved`;
    }

    await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "deposit_paid", notes } });
    return "OK quote marked deposit_paid";
  }

  if (paymentType === "balance") {
    const notes = appendQuoteNote(quote.notes, `${BALANCE_PAID_MARKER} (Shopify order ${orderLabel}).`);

    if (depositAlreadyPaid) {
      await db.quote.updateMany({ where: { id: quote.id, shop }, data: { status: "paid", notes } });
      return "OK quote marked paid (balance paid after deposit)";
    }

    await db.quote.updateMany({ where: { id: quote.id, shop }, data: { notes } });
    return "OK balance payment recorded; deposit not confirmed paid, status unchanged";
  }

  return "OK quote payment order not classified; status unchanged";
}

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  const order = payload as any;
  const note = String(order.note || "");

  const quoteIdMatch = note.match(/Quote ID:\s*([a-zA-Z0-9]+)/);
  const quoteId = quoteIdMatch?.[1];

  if (quoteId) {
    const message = await applyQuotePaymentFromOrder(shop, quoteId, order, note);
    return new Response(message, { status: 200 });
  }

  const result = await createProductionJobFromConfiguratorOrder(shop, order);

  return new Response(result.reason || "OK", { status: 200 });
};


