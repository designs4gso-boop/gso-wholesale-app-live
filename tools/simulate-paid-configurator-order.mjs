import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const shop = process.env.SHOP || "942075-2.myshopify.com";

function validImageUrl(value) {
  const url = String(value || "").trim();
  if (!url || url === "PASTE_SHOPIFY_IMAGE_URL_HERE") return "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

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

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function dateStamp(value = new Date()) {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}

function slugPart(value, fallback = "JOB") {
  const cleanValue = String(value || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  return cleanValue || fallback;
}

async function buildNextJobTicket(shop, now = new Date()) {
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

function itemTicketFor(jobTicket, index) {
  return `${jobTicket}-${String(index + 1).padStart(2, "0")}`;
}

function normalizeFilePart(value, fallback = "ITEM") {
  return slugPart(value || fallback, fallback).slice(0, 40);
}

function suggestedFileNameForItem(jobTicket, item, index) {
  const ticket = itemTicketFor(jobTicket, index);
  const product = normalizeFilePart(item.productTitle || item.title || "PRODUCT");
  const finish = normalizeFilePart(item.productionFinish || item.finish || "FINISH");
  const color = normalizeFilePart(item.bagColor || "COLOR");
  const qty = Number(item.quantity || 1);

  return `${ticket}_${product}_${finish}_${color}_QTY${qty}`;
}

function gid(type, value) {
  const raw = clean(value);
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/${type}/${raw}`;
}

async function main() {
  const jobTicket = await buildNextJobTicket(shop);
  const orderName = `TEST-CONFIG-${Date.now()}`;
  const quoteId = `test_shopify_order_${Date.now()}`;

  const configuredLines = [
    {
      productTitle: "Ritz Vanilla Cupcake",
      material: "Matte",
      finish: "4X Spot Gloss",
      productionFinish: "Matte + 4X Spot Gloss",
      bagColor: "Blue",
      sides: "Double Sided",
      quantity: 64,
      unitPrice: 2.80,
      sku: "",
      shopifyProductGid: "gid://shopify/Product/TEST",
      shopifyVariantGid: "gid://shopify/ProductVariant/TEST",
      productImageUrl: validImageUrl(process.env.SIMULATOR_PRODUCT_IMAGE_URL),
    },
    {
      productTitle: "Ritz Vanilla Cupcake",
      material: "Holographic",
      finish: "4X Spot Gloss",
      productionFinish: "Holo + White + 4X Spot Gloss",
      bagColor: "Blue",
      sides: "Double Sided",
      quantity: 1921,
      unitPrice: 2.10,
      sku: "",
      shopifyProductGid: "gid://shopify/Product/TEST",
      shopifyVariantGid: "gid://shopify/ProductVariant/TEST",
      productImageUrl: validImageUrl(process.env.SIMULATOR_PRODUCT_IMAGE_URL),
    },
  ];

  const mappedItems = configuredLines.map((line, index) => {
    const lineTotal = money(line.unitPrice * line.quantity);
    const variantTitle = `${line.material} / ${line.finish} / ${line.bagColor}`;

    const priceSnapshot = {
      source: "simulated_paid_configurator_order",
      orderName,
      material: line.material,
      finish: line.finish,
      productionFinish: line.productionFinish,
      bagColor: line.bagColor,
      sides: line.sides,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal,
    };

    const item = {
      productTitle: line.productTitle,
      variantTitle,
      sku: line.sku || null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      unitCost: 0,
      shopifyProductGid: line.shopifyProductGid,
      shopifyVariantGid: line.shopifyVariantGid,
      productImageUrl: line.productImageUrl || null,
      selectedFinish: line.productionFinish,
      selectedAddOns: JSON.stringify({
        material: line.material,
        finish: line.finish,
        productionFinish: line.productionFinish,
        bagColor: line.bagColor,
        sides: line.sides,
      }),
      materialSummary: `Material: ${line.material} | Finish: ${line.finish} | Production Finish: ${line.productionFinish} | Bag Color: ${line.bagColor} | Sides: ${line.sides}`,
      priceSnapshot: JSON.stringify(priceSnapshot),
      costSnapshot: JSON.stringify({
        source: "pending_cost_book_mapping",
        note: "Test job. Customer price captured; internal cost mapping comes later.",
      }),
      productionNotes: [
        `Simulated Shopify paid configurator order: ${orderName}`,
        `Material: ${line.material}`,
        `Finish: ${line.finish}`,
        `Production Finish: ${line.productionFinish}`,
        `Bag Color: ${line.bagColor}`,
        `Sides: ${line.sides}`,
      ].join("\n"),
      sortOrder: index + 1,
    };

    return {
      ...item,
      itemTicket: itemTicketFor(jobTicket, index),
      ripJobName: itemTicketFor(jobTicket, index),
      suggestedFileName: suggestedFileNameForItem(jobTicket, { productTitle: item.productTitle, productionFinish: line.productionFinish || productionFinish, finish: line.finish || finish, bagColor: line.bagColor || bagColor, quantity: item.quantity }, index),
    };
  });

  const job = await db.productionJob.create({
    data: {
      shop,
      quoteId,
      quoteNumber: orderName,
      jobTicket,
      assetInboxKey: jobTicket,
      customerName: "Test Customer",
      company: "GSO Configurator Test",
      email: "designs4gso@gmail.com",
      status: "new",
      priority: "normal",
      internalNotes: `TEST JOB created from simulated paid Shopify configurator order ${orderName}.`,
      productImageUrl: mappedItems.find((item) => item.productImageUrl)?.productImageUrl || null,
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
            eventType: "created_from_simulated_shopify_order",
            message: `Test production job ${jobTicket} created from simulated paid configurator order ${orderName}.`,
          },
        ],
      },
    },
    include: { items: true },
  });

  console.log(`Created test production job: ${job.jobTicket}`);
  console.log(`Job ID: ${job.id}`);
  console.log(`Items: ${job.items.length}`);
  console.log(`Open ERP Production Board and look for: ${job.jobTicket}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });



