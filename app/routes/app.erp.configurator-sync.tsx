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
  matchedCollection: boolean;
  alreadyInErp: boolean;
};

function cleanText(value: FormDataEntryValue | null | undefined, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function escapeSearchValue(value: string | null | undefined) {
  return String(value ?? "").replace(/"/g, '\\"');
}

function buildShopifyProductSearch(requiredTag: string | null | undefined) {
  const tag = String(requiredTag ?? "").trim();
  if (!tag) return "";
  return `tag:${escapeSearchValue(tag)}`;
}

function hasMatchingCollection(product: ShopifyProductPreview, collectionHandle: string) {
  const handle = collectionHandle.trim().toLowerCase();
  if (!handle) return true;
  return product.collections.some((collection) => collection.handle.toLowerCase() === handle);
}

async function fetchShopifyProducts({
  admin,
  requiredTag,
  collectionHandle,
  shopifyProductType,
  limit,
}: {
  admin: any;
  requiredTag: string;
  collectionHandle: string;
  shopifyProductType: string;
  limit: number;
}) {
  const queryText = buildShopifyProductSearch(requiredTag);
  const maxToFetch = Math.max(1, Math.min(limit || 50, 250));
  const products: ShopifyProductPreview[] = [];
  let after: string | null = null;

  const graphqlQuery = `#graphql
    query ConfiguratorSyncProducts($first: Int!, $after: String, $query: String!) {
      products(first: $first, after: $after, query: $query) {
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
            variants(first: 1) {
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
  `;

  while (products.length < maxToFetch) {
    const remaining = maxToFetch - products.length;
    const first = Math.min(50, remaining);

    const response = await admin.graphql(graphqlQuery, {
      variables: {
        first,
        after,
        query: queryText,
      },
    });

    const json = await response.json();
    const edges = json?.data?.products?.edges || [];

    for (const edge of edges) {
      const node = edge.node;
      const baseVariant = node.variants?.edges?.[0]?.node || null;
      const collections =
        node.collections?.edges?.map((collectionEdge: any) => ({
          id: collectionEdge.node.id,
          handle: collectionEdge.node.handle,
          title: collectionEdge.node.title,
        })) || [];

      const product: ShopifyProductPreview = {
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
        matchedCollection: false,
        alreadyInErp: false,
      };

      product.matchedCollection = hasMatchingCollection(product, collectionHandle);

      if (product.matchedCollection) {
        products.push(product);
      }
    }

    const pageInfo = json?.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    after = pageInfo.endCursor;
  }

  return products;
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
  collectionHandle,
}: {
  shop: string;
  products: ShopifyProductPreview[];
  requiredTag: string;
  collectionHandle: string;
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
      `Synced from Shopify configurator sync.`,
      collectionHandle ? `Collection handle: ${collectionHandle}` : null,
      requiredTag ? `Required tag: ${requiredTag}` : null,
      `Shopify status: ${product.status}`,
      product.collections.length
        ? `Collections: ${product.collections.map((collection) => collection.handle).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    if (existing) {
      await db.configuratorProduct.update({
        where: { id: existing.id },
        data: {
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
        },
      });
      updated += 1;
    } else {
      await db.configuratorProduct.create({
        data: {
          shop,
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
  const collectionHandle = cleanText(formData.get("collectionHandle"), "stock-bags");
  const requiredTag = cleanText(formData.get("requiredTag"), "configurator-pilot");
  const shopifyProductType = cleanText(formData.get("shopifyProductType"), "Stock Bag");
  const limitRaw = parseInt(cleanText(formData.get("limit"), "50"), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  const fetchedProducts = await fetchShopifyProducts({
    admin,
    requiredTag,
    collectionHandle,
    shopifyProductType,
    limit,
  });

  const products = await markExistingProducts(session.shop, fetchedProducts);

  if (intent === "preview") {
    return {
      ok: true,
      intent,
      message: `Preview found ${products.length} matching Shopify products.`,
      collectionHandle,
      requiredTag,
      shopifyProductType,
      limit,
      products,
      syncResult: null,
    };
  }

  if (intent === "sync") {
    const syncResult = await syncProductsToErp({
      shop: session.shop,
      products,
      requiredTag,
      collectionHandle,
    });

    return {
      ok: true,
      intent,
      message: `Sync complete: ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.skipped} skipped.`,
      collectionHandle,
      requiredTag,
      shopifyProductType,
      limit,
      products,
      syncResult,
    };
  }

  return {
    ok: false,
    intent,
    message: "No action taken.",
    collectionHandle,
    requiredTag,
    shopifyProductType,
    limit,
    products: [],
    syncResult: null,
  };
}

export default function ConfiguratorSync() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const defaults = {
    collectionHandle: actionData?.collectionHandle || "stock-bags",
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
            Sync Shopify products into ERP configurator records by collection handle, product type,
            and required tag. This replaces manual product mapping for large catalogs.
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

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Sync Settings</h2>
            <p className="muted">
              For the 5-product pilot, use collection handle <b>stock-bags</b> and required tag <b>configurator-pilot</b>.
              Later, remove or change the tag to sync the full catalog.
            </p>
          </div>
          <a className="link-button" href="/app/erp/configurator">Back to Configurator</a>
        </div>

        <Form method="post" className="form-grid">
          <label>
            Shopify Collection Handle
            <input name="collectionHandle" defaultValue={defaults.collectionHandle} placeholder="stock-bags" />
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
            <input name="limit" type="number" min="1" max="250" defaultValue={defaults.limit} />
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
            These products matched the sync filters and collection post-filter. Review the base variant and SKU before syncing.
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Product</th>
                  <th>Handle</th>
                  <th>Product Type</th>
                  <th>Tags</th>
                  <th>Base Variant</th>
                  <th>SKU</th>
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
                      <strong>{product.title}</strong>
                      <small>{product.id}</small>
                    </td>
                    <td>{product.handle}</td>
                    <td>{product.productType || "-"}</td>
                    <td>{product.tags.join(", ") || "-"}</td>
                    <td>{product.baseVariantTitle || "Missing"}</td>
                    <td>{product.baseVariantSku || "-"}</td>
                    <td>{product.collections.map((collection) => collection.handle).join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : actionData ? (
        <div className="card">
          <h2>No products matched</h2>
          <p className="muted">
            Check the collection handle, required tag, and Shopify product type. For pilot testing,
            make sure the selected products are in the Stock Bags collection and tagged configurator-pilot.
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
.gso-page {
  padding: 24px;
  max-width: 1280px;
  margin: 0 auto;
  color: #202223;
}
.hero {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px;
  border-radius: 18px;
  background: linear-gradient(135deg, #111827, #312e81);
  color: white;
  margin-bottom: 20px;
}
.hero h1 {
  margin: 0 0 8px;
  font-size: 34px;
}
.hero p {
  max-width: 760px;
  margin: 0;
  color: #e5e7eb;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px !important;
}
.hero-card {
  min-width: 280px;
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.card {
  background: white;
  border: 1px solid #dfe3e8;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.card h2 {
  margin-top: 0;
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.muted {
  color: #6d7175;
}
.notice {
  padding: 10px;
  border-radius: 10px;
  margin-bottom: 12px;
}
.notice.warning {
  background: #fff4e5;
  border: 1px solid #ffb84d;
  color: #7a4b00;
}
.notice.success {
  background: #ecfdf3;
  border: 1px solid #86efac;
  color: #14532d;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 650;
}
input {
  min-height: 42px;
  border: 1px solid #c9cccf;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 14px;
}
.button-row {
  grid-column: span 2;
  display: flex;
  gap: 10px;
  align-items: center;
}
button,
.link-button {
  min-height: 42px;
  border: none;
  border-radius: 10px;
  padding: 10px 16px;
  background: #111827;
  color: white;
  font-weight: 700;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
button.secondary {
  background: #f6f6f7;
  color: #111827;
  border: 1px solid #c9cccf;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.grid.four {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
}
.stat span {
  display: block;
  color: #6d7175;
  font-size: 13px;
}
.stat strong {
  display: block;
  margin-top: 4px;
  font-size: 28px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border-bottom: 1px solid #e1e3e5;
  padding: 10px;
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
}
th {
  background: #f6f6f7;
}
td small {
  display: block;
  color: #6d7175;
  margin-top: 4px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill {
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 12px;
  font-weight: 700;
}
.pill.good {
  background: #ecfdf3;
  color: #14532d;
  border: 1px solid #86efac;
}
.pill.needs {
  background: #fff4e5;
  color: #7a4b00;
  border: 1px solid #ffb84d;
}
ol {
  margin-bottom: 0;
}
@media (max-width: 900px) {
  .hero,
  .card-head,
  .form-grid,
  .grid.four {
    grid-template-columns: 1fr;
    display: grid;
  }
  .button-row {
    grid-column: span 1;
    align-items: stretch;
    flex-direction: column;
  }
}
`;


