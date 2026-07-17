import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { MIN_QTY, PRODUCT_TYPE, PRODUCT_TYPE_LABEL } from "../lib/configurator-pricing";

type ShopifyProductPreview = {
  id: string;
  title: string;
  handle: string;
  productType: string;
  status: string;
  tags: string[];
  baseVariantId: string | null;
  baseVariantSku: string | null;
  baseVariantTitle: string | null;
  collections: { id: string; handle: string; title: string }[];
  imageUrl: string | null;
  alreadyInErp: boolean;
};

function cleanText(value: FormDataEntryValue | null | undefined, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function digitsOnly(value: string | null | undefined) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function collectionGid(value: string | null | undefined) {
  const digits = digitsOnly(value);
  if (!digits) return null;
  return `gid://shopify/Collection/${digits}`;
}

function tagMatches(tags: string[] | null | undefined, requiredTag: string | null | undefined) {
  const target = String(requiredTag ?? "").trim().toLowerCase();
  if (!target) return true;
  return (tags || []).some((tag) => String(tag ?? "").trim().toLowerCase() === target);
}

function textMatches(value: string | null | undefined, expected: string | null | undefined) {
  const cleanExpected = String(expected ?? "").trim().toLowerCase();
  if (!cleanExpected) return true;
  return String(value ?? "").trim().toLowerCase() === cleanExpected;
}

function assessPipelineReadiness(
  product: {
    handle: string;
    productType: string;
    status: string;
    tags: string[];
    totalVariants: number;
    options: { name: string; values: string[] }[];
    baseVariantId: string | null;
    baseVariantTitle: string | null;
    collections: { id: string; handle: string; title: string }[];
  },
  requiredTag: string,
  shopifyProductType: string,
  collectionInput: string,
) {
  const issues: string[] = [];
  const oldOptionNames = ["sided", "side", "material", "bag color", "color", "finish", "gloss", "spot gloss", "quantity"];
  const expectedCollectionGid = collectionGid(collectionInput);
  const optionNames = (product.options || []).map((option) => String(option.name || "").trim());
  const normalizedOptionNames = optionNames.map((name) => name.toLowerCase());
  const hasOldOptions = normalizedOptionNames.some((name) => oldOptionNames.includes(name));
  const hasOnlyDefaultTitleOption =
    optionNames.length === 0 ||
    (optionNames.length === 1 &&
      normalizedOptionNames[0] === "title" &&
      String(product.baseVariantTitle || "").trim().toLowerCase() === "default title");

  if (String(product.status || "").trim().toUpperCase() !== "ACTIVE") {
    issues.push("Product not ACTIVE");
  }

  if (!String(product.handle || "").trim()) {
    issues.push("Missing handle");
  }

  if (!textMatches(product.productType, shopifyProductType)) {
    issues.push("Wrong product type");
  }

  if (!tagMatches(product.tags, requiredTag)) {
    issues.push(`Missing tag ${requiredTag}`);
  }

  if (expectedCollectionGid && !(product.collections || []).some((collection) => collection.id === expectedCollectionGid)) {
    issues.push("Missing Stock Bags collection");
  }

  const hasUsableDefaultVariant =
    !!product.baseVariantId &&
    String(product.baseVariantTitle || "").trim().toLowerCase() === "default title";

  if (Number(product.totalVariants || 0) > 1) {
    issues.push(`Variant count must be exactly 1; detected ${product.totalVariants || 0}`);
  }

  if (Number(product.totalVariants || 0) === 0 && !hasUsableDefaultVariant) {
    issues.push("Missing usable default variant");
  }

  if (!product.baseVariantId) {
    issues.push("Missing default variant GID");
  }

  if (hasOldOptions) {
    issues.push(`Old Shopify options still present: ${optionNames.join(", ")}`);
  }

  if (!hasOnlyDefaultTitleOption) {
    issues.push(`Option is not Title / Default Title: ${optionNames.join(", ") || "none"}`);
  }

  if (issues.length) {
    return {
      label: issues.some((issue) => issue.includes("Multiple variants") || issue.includes("Variant count") || issue.includes("Old Shopify options"))
        ? "Pending Shopify Cleanup"
        : "Needs Setup",
      tone: "warning",
      details: issues.join("; "),
      ready: false,
    };
  }

  return {
    label: "Ready for ERP Sync",
    tone: "success",
    details: "Active, tagged, single default variant, and ERP-compatible.",
    ready: true,
  };
}
function normalizeProduct(node: any): ShopifyProductPreview {
  const variantEdges = node.variants?.edges || [];
  const baseVariant = variantEdges[0]?.node || null;
  const detectedVariantCount =
    Number(node.variantsCount?.count || 0) > 0
      ? Number(node.variantsCount.count)
      : Number(node.totalVariants || 0) > 0
        ? Number(node.totalVariants)
        : variantEdges.length > 0
          ? variantEdges.length
          : baseVariant?.id
            ? 1
            : 0;

  const collections =
    node.collections?.edges?.map((edge: any) => ({
      id: edge.node.id,
      handle: edge.node.handle,
      title: edge.node.title,
    })) || [];

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    productType: node.productType || "",
    status: node.status || "",
    tags: node.tags || [],
    baseVariantId: baseVariant?.id || null,
    baseVariantSku: baseVariant?.sku || null,
    baseVariantTitle: baseVariant?.title || null,
    collections,
    imageUrl: node.featuredMedia?.preview?.image?.url || null,
    alreadyInErp: false,
  };
}

async function fetchProductsFromCollection({
  admin,
  collectionInput,
  limit,
}: {
  admin: any;
  collectionInput: string;
  limit: number;
}) {
  const gid = collectionGid(collectionInput);
  const products: ShopifyProductPreview[] = [];
  let after: string | null = null;

  const debug = {
    mode: gid ? "collection_id" : "no_collection_id",
    collectionGid: gid || "",
    rawFetchedCount: 0,
    tagMatchedCount: 0,
    productTypeMatchedCount: 0,
    finalMatchedCount: 0,
    error: "",
  };

  if (!gid) {
    debug.error = "Collection must be a numeric Shopify collection ID for this direct collection sync.";
    return { products, debug };
  }

  const graphqlQuery = `#graphql
    query ConfiguratorCollectionProducts($id: ID!, $first: Int!, $after: String) {
      collection(id: $id) {
        id
        title
        handle
        products(first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              title
              handle
              productType
              status
              tags
              featuredMedia {
                preview {
                  image {
                    url
                  }
                }
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    sku
                    title
                  }
                }
              }
              collections(first: 20) {
                edges {
                  node {
                    id
                    handle
                    title
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  const maxToFetch = Math.max(1, Math.min(limit || 50, 2000));

  while (products.length < maxToFetch) {
    const first = Math.min(50, maxToFetch - products.length);

    const response = await admin.graphql(graphqlQuery, {
      variables: {
        id: gid,
        first,
        after,
      },
    });

    const json = await response.json();

    if (json?.errors?.length) {
      debug.error = JSON.stringify(json.errors);
      break;
    }

    const collection = json?.data?.collection;
    if (!collection) {
      debug.error = `No Shopify collection found for ${gid}`;
      break;
    }

    const edges = collection.products?.edges || [];
    debug.rawFetchedCount += edges.length;

    for (const edge of edges) {
      products.push(normalizeProduct(edge.node));
    }

    const pageInfo = collection.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    after = pageInfo.endCursor;
  }

  return { products, debug };
}

async function markExistingProducts(shop: string, products: ShopifyProductPreview[]) {
  if (!products.length) return products;

  const existing = await db.configuratorProduct.findMany({
    where: {
      shop,
      productType: PRODUCT_TYPE,
      OR: [
        { shopifyProductGid: { in: products.map((product) => product.id) } },
        { title: { in: products.map((product) => product.title) } },
      ],
    },
    select: {
      id: true,
      title: true,
      shopifyProductGid: true,
    },
  });

  const existingGids = new Set(existing.map((item) => item.shopifyProductGid).filter(Boolean));
  const existingTitles = new Set(existing.map((item) => item.title));

  return products.map((product) => ({
    ...product,
    alreadyInErp: existingGids.has(product.id) || existingTitles.has(product.title),
  }));
}

async function syncProductsToErp({
  shop,
  products,
  requiredTag,
  collectionInput,
}: {
  shop: string;
  products: ShopifyProductPreview[];
  requiredTag: string;
  collectionInput: string;
}) {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let missingVariant = 0;

  for (const product of products) {
    if (!product.baseVariantId) {
      missingVariant += 1;
      skipped += 1;
      continue;
    }

    const existing = await db.configuratorProduct.findFirst({
      where: {
        shop,
        productType: PRODUCT_TYPE,
        OR: [{ shopifyProductGid: product.id }, { title: product.title }],
      },
    });

    const notes = [
      "Synced from Shopify direct collection sync.",
      `Collection input: ${collectionInput}`,
      requiredTag ? `Required tag: ${requiredTag}` : null,
      `Shopify status: ${product.status}`,
      product.collections.length
        ? `Collections: ${product.collections.map((collection) => collection.handle).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const data = {
      title: product.title,
      shopifyProductGid: product.id,
      shopifyVariantGid: product.baseVariantId,
      shopifyHandle: product.handle,
      sku: product.baseVariantSku,
      productType: PRODUCT_TYPE,
      defaultSides: "Double Sided",
      minQuantity: MIN_QTY,
      pilot: requiredTag === "configurator-pilot" || product.tags.includes("configurator-pilot"),
      active: true,
      notes,
    };

    if (existing) {
      await db.configuratorProduct.update({
        where: { id: existing.id },
        data,
      });
      updated += 1;
    } else {
      await db.configuratorProduct.create({
        data: {
          shop,
          ...data,
        },
      });
      created += 1;
    }
  }

  return {
    created,
    updated,
    skipped,
    missingVariant,
    totalMatched: products.length,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const count = await db.configuratorProduct.count({
    where: {
      shop: session.shop,
      productType: PRODUCT_TYPE,
    },
  });

  return {
    shop: session.shop,
    productType: PRODUCT_TYPE,
    productTypeLabel: PRODUCT_TYPE_LABEL,
    currentConfiguratorProducts: count,
  };
}

export async function action({ request }: { request: Request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = cleanText(formData.get("intent"));
  const collectionInput = cleanText(formData.get("collectionInput"), "302046380097");
  const requiredTag = cleanText(formData.get("requiredTag"), "configurator-pilot");
  const shopifyProductType = cleanText(formData.get("shopifyProductType"), "Stock Bag");
  const limitRaw = parseInt(cleanText(formData.get("limit"), "50"), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  const fetchedResult = await fetchProductsFromCollection({
    admin,
    collectionInput,
    limit,
  });

  const filteredProducts = fetchedResult.products.filter((product) => {
    const matchedTag = tagMatches(product.tags, requiredTag);
    const matchedProductType = textMatches(product.productType, shopifyProductType);

    if (matchedTag) fetchedResult.debug.tagMatchedCount += 1;
    if (matchedProductType) fetchedResult.debug.productTypeMatchedCount += 1;

    return matchedTag && matchedProductType;
  });

  fetchedResult.debug.finalMatchedCount = filteredProducts.length;

  const products = (await markExistingProducts(session.shop, filteredProducts)).map((product) => {
    const readiness = assessPipelineReadiness(product, requiredTag, shopifyProductType, collectionInput);
    return {
      ...product,
      readinessLabel: readiness.label,
      readinessTone: readiness.tone,
      readinessDetails: readiness.details,
      erpReady: readiness.ready,
    };
  });

  if (intent === "preview") {
    return {
      ok: true,
      intent,
      message: `Preview found ${products.length} matching Shopify products.`,
      collectionInput,
      requiredTag,
      shopifyProductType,
      limit,
      products,
      debug: fetchedResult.debug,
      syncResult: null,
    };
  }

  if (intent === "sync") {
    const syncResult = await syncProductsToErp({
      shop: session.shop,
      products,
      requiredTag,
      collectionInput,
    });

    return {
      ok: true,
      intent,
      message: `Sync complete: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.skipped} skipped.`,
      collectionInput,
      requiredTag,
      shopifyProductType,
      limit,
      products,
      debug: fetchedResult.debug,
      syncResult,
    };
  }

  return {
    ok: false,
    intent,
    message: "No action taken.",
    collectionInput,
    requiredTag,
    shopifyProductType,
    limit,
    products: [],
    debug: null,
    syncResult: null,
  };
}

export default function ConfiguratorSync() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const defaults = {
    collectionInput: actionData?.collectionInput || "302046380097",
    requiredTag: actionData?.requiredTag || "configurator-pilot",
    shopifyProductType: actionData?.shopifyProductType || "Stock Bag",
    limit: actionData?.limit || 50,
  };

  return (
    <div className="gso-page">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      <div className="hero">
        <div>
          <p className="eyebrow">GSO ERP Configurator</p>
          <h1>Shopify Collection / Tag Sync</h1>
          <p>
            Sync Shopify products into ERP configurator records by direct collection ID, then filter by tag
            and product type inside ERP. This replaces manual product mapping for large catalogs.
          </p>
          <p style={{ border: "2px solid #f59e0b", background: "#fffbeb", color: "#92400e", borderRadius: 12, padding: "10px 14px", fontSize: 13, fontWeight: 700 }}>
            Owner / advanced tool — changes here can affect live pricing, mappings, or Shopify behavior.
          </p>
        </div>
        <div className="hero-card">
          <strong>Sync Target</strong>
          <span>ERP Type: {data.productTypeLabel}</span>
          <span>Min Qty: {MIN_QTY}</span>
          <span>Sides: Double Sided</span>
          <span>Current ERP products: {data.currentConfiguratorProducts}</span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice success" : "notice warning"}>{actionData.message}</div>
      ) : null}

      {actionData?.debug ? (
        <div className="card debug-card">
          <h2>Pipeline Verification Report</h2>
          <div className="debug-grid">
            <div><span>Mode</span><strong>{actionData.debug.mode}</strong></div>
            <div><span>Collection GID</span><strong>{actionData.debug.collectionGid || "-"}</strong></div>
            <div><span>Raw Shopify Products Returned</span><strong>{actionData.debug.rawFetchedCount}</strong></div>
            <div><span>Tag Matched</span><strong>{actionData.debug.tagMatchedCount}</strong></div>
            <div><span>Product Type Matched</span><strong>{actionData.debug.productTypeMatchedCount}</strong></div>
            <div><span>Final Matched</span><strong>{actionData.debug.finalMatchedCount}</strong></div>
            <div><span>ERP Ready</span><strong>{actionData.products?.filter((product: any) => product.erpReady).length || 0}</strong></div>
          </div>
          {actionData.debug.error ? <p className="error-text">{actionData.debug.error}</p> : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Sync Settings</h2>
            <p className="muted">
              Use this read-only preview first to verify stock bag pipeline readiness before syncing into ERP. Default rollout settings are Stock Bags collection ID <b>302046380097</b>, required tag{" "}<b>configurator-pilot</b>, and Shopify product type <b>Stock Bag</b>.
            </p>
          </div>
          <a className="link-button" href="/app/erp/configurator">Back to Configurator</a>
        </div>

        <Form method="post" className="form-grid">
          <label>
            Shopify Collection ID
            <input name="collectionInput" defaultValue={defaults.collectionInput} placeholder="302046380097" />
          </label>

          <label>
            Required Product Tag
            <input name="requiredTag" defaultValue={defaults.requiredTag} placeholder="configurator-pilot" />
          </label>

          <label>
            Shopify Product Type
            <input name="shopifyProductType" defaultValue={defaults.shopifyProductType} placeholder="Stock Bag" />
          </label>

          <label>
            Max Products To Scan
            <input name="limit" type="number" min="1" max="2000" defaultValue={defaults.limit} />
          </label>

          <div className="button-row">
            <button type="submit" name="intent" value="preview" disabled={isSubmitting}>
              {isSubmitting ? "Working..." : "Preview Matching Products"}
            </button>
            <button type="submit" name="intent" value="sync" className="secondary" disabled={isSubmitting}>
              {isSubmitting ? "Working..." : "Sync Products Into ERP"}
            </button>
          </div>
        </Form>
      </div>

      {actionData?.syncResult ? (
        <div className="grid four">
          <div className="card stat"><span>Created</span><strong>{actionData.syncResult.created}</strong></div>
          <div className="card stat"><span>Updated</span><strong>{actionData.syncResult.updated}</strong></div>
          <div className="card stat"><span>Skipped</span><strong>{actionData.syncResult.skipped}</strong></div>
          <div className="card stat"><span>Missing Variant</span><strong>{actionData.syncResult.missingVariant}</strong></div>
        </div>
      ) : null}

      {actionData?.products?.length ? (
        <div className="card">
          <h2>Matched Shopify Products</h2>
          <p className="muted">
            Products should only be synced into ERP after the full stock bag pipeline finishes and Pipeline Check says{" "}
            <b>Ready for ERP Sync</b>. If a product says <b>Pending Shopify Cleanup</b> or <b>Needs Setup</b>,
            do not sync it yet; let the pipeline finish or fix the listed readiness issue first.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ERP Status</th>
                  <th>Pipeline Check</th>
                  <th>Product</th>
                  <th>Handle</th>
                  <th>Product Type</th>
                  <th>Variants</th>
                  <th>Options</th>
                  <th>Base Variant</th>
                  <th>SKU</th>
                  <th>Tags</th>
                  <th>Collections</th>
                </tr>
              </thead>
              <tbody>
                {actionData.products.map((product: ShopifyProductPreview) => (
                  <tr key={product.id}>
                    <td>
                      <span className={product.alreadyInErp ? "pill good" : "pill needs"}>
                        {product.alreadyInErp ? "Already in ERP" : "New"}
                      </span>
                    </td>
                    <td>
                      <span className={product.erpReady ? "pill good" : "pill needs"}>
                        {product.readinessLabel || "Not checked"}
                      </span>
                      <small>{product.readinessDetails || "-"}</small>
                    </td>
                    <td>
                      <strong>{product.title}</strong>
                      <small>{product.id}</small>
                    </td>
                    <td>{product.handle || "Missing"}</td>
                    <td>{product.productType || "-"}</td>
                    <td>{product.totalVariants || (product.baseVariantId ? 1 : 0)}</td>
                    <td>
                      {product.options?.length
                        ? product.options.map((option) => `${option.name}: ${option.values.join(", ")}`).join(" | ")
                        : "-"}
                    </td>
                    <td>{product.baseVariantTitle || "Missing"}</td>
                    <td>{product.baseVariantSku || "-"}</td>
                    <td>{product.tags.join(", ") || "-"}</td>
                    <td>{product.collections.map((collection) => collection.handle).join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>      ) : actionData ? (
        <div className="card">
          <h2>No products matched</h2>
          <p className="muted">
            Check the Sync Debug box above. If Raw Shopify Products Returned is above 0 but Final Matched is 0,
            the blocker is either the required tag or product type filter.
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>Next After Sync Works</h2>
        <ol>
          <li>Use synced ConfiguratorProduct records for storefront product matching.</li>
          <li>Add storefront configurator block only for products tagged configurator-pilot.</li>
          <li>Send Material, Finish, Bag Color, Quantity, ERP Product ID, and ERP Config ID as line item properties.</li>
          <li>Update order paid webhook to create production jobs from configured order line properties.</li>
        </ol>
      </div>
    </div>
  );
}

const styles = `
.gso-page { padding: 24px; max-width: 1280px; margin: 0 auto; color: #202223; }
.hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, #111827, #312e81); color: white; margin-bottom: 20px; }
.hero h1 { margin: 0 0 8px; font-size: 34px; }
.hero p { max-width: 760px; margin: 0; color: #e5e7eb; }
.eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; font-weight: 700; margin-bottom: 8px !important; }
.hero-card { min-width: 280px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.card { background: white; border: 1px solid #dfe3e8; border-radius: 16px; padding: 20px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.card h2 { margin-top: 0; }
.card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.muted { color: #6d7175; }
.notice { padding: 10px; border-radius: 10px; margin-bottom: 12px; }
.notice.warning { background: #fff4e5; border: 1px solid #ffb84d; color: #7a4b00; }
.notice.success { background: #ecfdf3; border: 1px solid #86efac; color: #14532d; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
label { display: flex; flex-direction: column; gap: 6px; font-weight: 650; }
input { min-height: 42px; border: 1px solid #c9cccf; border-radius: 10px; padding: 8px 10px; font-size: 14px; }
.button-row { grid-column: span 2; display: flex; gap: 10px; align-items: center; }
button, .link-button { min-height: 42px; border: none; border-radius: 10px; padding: 10px 16px; background: #111827; color: white; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
button.secondary { background: #f6f6f7; color: #111827; border: 1px solid #c9cccf; }
button:disabled { opacity: 0.6; cursor: default; }
.grid.four { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
.stat span { display: block; color: #6d7175; font-size: 13px; }
.stat strong { display: block; margin-top: 4px; font-size: 28px; }
.debug-card { border-color: #93c5fd; }
.debug-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.debug-grid div { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 12px; }
.debug-grid span { display: block; color: #1d4ed8; font-size: 12px; }
.debug-grid strong { display: block; margin-top: 4px; word-break: break-word; }
.error-text { color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; padding: 10px; border-radius: 10px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid #e1e3e5; padding: 10px; text-align: left; vertical-align: top; white-space: nowrap; }
th { background: #f6f6f7; }
td small { display: block; color: #6d7175; margin-top: 4px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.pill { border-radius: 999px; padding: 5px 8px; font-size: 12px; font-weight: 700; }
.pill.good { background: #ecfdf3; color: #14532d; border: 1px solid #86efac; }
.pill.needs { background: #fff4e5; color: #7a4b00; border: 1px solid #ffb84d; }
ol { margin-bottom: 0; }
@media (max-width: 900px) {
  .hero, .card-head, .form-grid, .grid.four, .debug-grid { grid-template-columns: 1fr; display: grid; }
  .button-row { grid-column: span 1; align-items: stretch; flex-direction: column; }
}
`;











