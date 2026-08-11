import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// 15H.1-G: FAIL CLOSED against production. The local .env DATABASE_URL points
// at the PRODUCTION Postgres — this dev simulator refuses to run against any
// non-SQLite database unless the owner/developer supplies the explicit flag:
//   ALLOW_PRODUCTION_SIMULATION=YES_I_UNDERSTAND_THIS_WRITES_PRODUCTION
const ALLOW_PRODUCTION_PHRASE = "YES_I_UNDERSTAND_THIS_WRITES_PRODUCTION";
const databaseUrl = String(process.env.DATABASE_URL || "");
const isLocalSqlite = databaseUrl.startsWith("file:");
if (!isLocalSqlite && process.env.ALLOW_PRODUCTION_SIMULATION !== ALLOW_PRODUCTION_PHRASE) {
  console.error("REFUSED: DATABASE_URL is not a local SQLite file — this looks like a production database.");
  console.error(`To run anyway, set ALLOW_PRODUCTION_SIMULATION=${ALLOW_PRODUCTION_PHRASE}`);
  process.exit(3);
}

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

// 15H.1-F: the simulator's local ticket generator is RETIRED. This tool can
// no longer mint GSO tickets independently — jobs are created UNTICKETED and
// tickets are assigned afterwards by the admin "Backfill Tickets" action,
// which uses the central authoritative allocator (advisory-locked +
// DB-unique-backed) in app/lib/production-job-source.server.ts.

function gid(type, value) {
  const raw = clean(value);
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  return `gid://shopify/${type}/${raw}`;
}

async function main() {
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

    // 15H.1: no ticket fields — itemTicket/ripJobName/suggestedFileName are
    // assigned by the admin Backfill Tickets action (central allocator).
    return item;
  });

  const job = await db.productionJob.create({
    data: {
      shop,
      quoteId,
      quoteNumber: orderName,
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
            message: `Test production job (unticketed) created from simulated paid configurator order ${orderName}. Assign tickets via Production Board -> Backfill Tickets.`,
          },
        ],
      },
    },
    include: { items: true },
  });

  console.log(`Created test production job (NO ticket — by design since 15H.1).`);
  console.log(`Job ID: ${job.id}`);
  console.log(`Items: ${job.items.length}`);
  console.log(`Assign the ticket via Production Board -> "Backfill Tickets" (central allocator).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });



