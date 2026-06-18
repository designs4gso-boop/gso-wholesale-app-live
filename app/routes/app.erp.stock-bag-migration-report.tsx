import { Form, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

const DEFAULT_COLLECTION_ID = "302046380097";
const DEFAULT_REQUIRED_TAG = "configurator-pilot";
const DEFAULT_PRODUCT_TYPE = "Stock Bag";

function cleanText(value: FormDataEntryValue | null | undefined, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function digitsOnly(value: string | null | undefined) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function collectionGid(value: string | null | undefined) {
  const digits = digitsOnly(value);
  if (!digits) return "";
  return `gid://shopify/Collection/${digits}`;
}

function tagMatches(tags: string[] | null | undefined, requiredTag: string) {
  const target = String(requiredTag || "").trim().toLowerCase();
  if (!target) return true;
  return (tags || []).some((tag) => String(tag || "").trim().toLowerCase() === target);
}

function textMatches(value: string | null | undefined, expected: string) {
  const target = String(expected || "").trim().toLowerCase();
  if (!target) return true;
  return String(value || "").trim().toLowerCase() === target;
}

function normalizeProduct(node: any) {
  const variantEdges = node.variants?.edges || [];
  const baseVariant = variantEdges[0]?.node || null;
  const variantCount =
    Number(node.variantsCount?.count || 0) > 0
      ? Number(node.variantsCount.count)
      : variantEdges.length > 0
        ? variantEdges.length
        : baseVariant?.id
          ? 1
          : 0;

  const collections =
    node.collections?.edges?.map((edge: any) => ({
      id: edge.node?.id || "",
      handle: edge.node?.handle || "",
      title: edge.node?.title || "",
    })) || [];

  return {
    id: node.id || "",
    title: node.title || "",
    handle: node.handle || "",
    productType: node.productType || "",
    status: node.status || "",
    tags: node.tags || [],
    totalVariants: variantCount,
    options: node.options || [],
    baseVariantId: baseVariant?.id || "",
    baseVariantTitle: baseVariant?.title || "",
    baseVariantSku: baseVariant?.sku || "",
    collections,
  };
}

function assess(product: any, requiredTag: string, shopifyProductType: string, expectedCollectionGid: string) {
  const issues: string[] = [];
  const optionNames = (product.options || []).map((option: any) => String(option.name || "").trim());
  const normalizedOptionNames = optionNames.map((name: string) => name.toLowerCase());
  const oldOptionNames = ["sided", "side", "material", "bag color", "color", "finish", "gloss", "spot gloss", "quantity"];

  const hasOldOptions = normalizedOptionNames.some((name: string) => oldOptionNames.includes(name));
  const hasDefaultTitleOption =
    optionNames.length === 0 ||
    (optionNames.length === 1 &&
      normalizedOptionNames[0] === "title" &&
      String(product.baseVariantTitle || "").trim().toLowerCase() === "default title");

  const inExpectedCollection = (product.collections || []).some((collection: any) => collection.id === expectedCollectionGid);

  if (!product.id) issues.push("Missing product GID");
  if (!product.handle) issues.push("Missing handle");
  if (String(product.status || "").toUpperCase() !== "ACTIVE") issues.push("Not active");
  if (!tagMatches(product.tags, requiredTag)) issues.push("Missing required tag");
  if (!textMatches(product.productType, shopifyProductType)) issues.push("Wrong Shopify product type");
  if (expectedCollectionGid && !inExpectedCollection) issues.push("Missing Stock Bags collection");
  if (!product.baseVariantId) issues.push("Missing variant GID");
  if (Number(product.totalVariants || 0) !== 1) issues.push(`Wrong variant count: ${product.totalVariants || 0}`);
  if (!hasDefaultTitleOption) issues.push("Default Title option issue");
  if (hasOldOptions) issues.push(`Old Shopify options still present: ${optionNames.join(", ")}`);

  const ready = issues.length === 0;

  return {
    ready,
    label: ready ? "Ready for ERP Sync" : issues.some((issue) => issue.includes("Old Shopify options") || issue.includes("variant count"))
      ? "Pending Shopify Cleanup"
      : "Needs Setup",
    issues,
  };
}

async function fetchCollectionProducts({
  admin,
  collectionInput,
  limit,
}: {
  admin: any;
  collectionInput: string;
  limit: number;
}) {
  const gid = collectionGid(collectionInput);
  const products: any[] = [];
  const debug = {
    collectionGid: gid,
    requestedLimit: limit,
    rawFetchedCount: 0,
    error: "",
  };

  if (!gid) {
    debug.error = "Collection must be a numeric Shopify collection ID.";
    return { products, debug };
  }

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage && products.length < limit) {
    const pageSize = Math.min(50, limit - products.length);

    const response = await admin.graphql(
      `#graphql
        query StockBagMigrationReport($collectionId: ID!, $first: Int!, $after: String) {
          collection(id: $collectionId) {
            id
            title
            handle
            products(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  handle
                  productType
                  status
                  tags
                  options {
                    name
                    values
                  }
                  variantsCount {
                    count
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
                  collections(first: 10) {
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
            }
          }
        }
      `,
      {
        variables: {
          collectionId: gid,
          first: pageSize,
          after,
        },
      },
    );

    const payload = await response.json();
    const collection = payload?.data?.collection;

    if (!collection) {
      debug.error = payload?.errors?.map((error: any) => error.message).join("; ") || "Collection not found.";
      break;
    }

    const edges = collection.products?.edges || [];
    products.push(...edges.map((edge: any) => normalizeProduct(edge.node)));

    debug.rawFetchedCount = products.length;
    hasNextPage = !!collection.products?.pageInfo?.hasNextPage;
    after = collection.products?.pageInfo?.endCursor || null;

    if (!edges.length) break;
  }

  return { products, debug };
}

export async function action({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const collectionInput = cleanText(formData.get("collectionInput"), DEFAULT_COLLECTION_ID);
  const requiredTag = cleanText(formData.get("requiredTag"), DEFAULT_REQUIRED_TAG);
  const shopifyProductType = cleanText(formData.get("shopifyProductType"), DEFAULT_PRODUCT_TYPE);
  const limitRaw = parseInt(cleanText(formData.get("limit"), "250"), 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 250, 1), 2000);
  const expectedCollectionGid = collectionGid(collectionInput);

  const fetched = await fetchCollectionProducts({
    admin,
    collectionInput,
    limit,
  });

  const rows = fetched.products.map((product) => {
    const readiness = assess(product, requiredTag, shopifyProductType, expectedCollectionGid);
    return {
      ...product,
      readiness,
    };
  });

  const tagMatched = rows.filter((product) => tagMatches(product.tags, requiredTag));
  const productTypeMatched = rows.filter((product) => textMatches(product.productType, shopifyProductType));
  const finalMatched = rows.filter((product) => tagMatches(product.tags, requiredTag) && textMatches(product.productType, shopifyProductType));
  const readyRows = rows.filter((product) => product.readiness.ready);

  const totals = {
    scanned: rows.length,
    tagMatched: tagMatched.length,
    productTypeMatched: productTypeMatched.length,
    finalMatched: finalMatched.length,
    erpReady: readyRows.length,
    notReady: rows.filter((product) => !product.readiness.ready).length,
    pendingShopifyCleanup: rows.filter((product) => product.readiness.label === "Pending Shopify Cleanup").length,
    needsSetup: rows.filter((product) => product.readiness.label === "Needs Setup").length,
    missingProductGid: rows.filter((product) => !product.id).length,
    missingVariantGid: rows.filter((product) => !product.baseVariantId).length,
    wrongVariantCount: rows.filter((product) => Number(product.totalVariants || 0) !== 1).length,
    defaultVariantIssues: rows.filter((product) => String(product.baseVariantTitle || "").trim().toLowerCase() !== "default title").length,
    missingHandle: rows.filter((product) => !product.handle).length,
    notActive: rows.filter((product) => String(product.status || "").toUpperCase() !== "ACTIVE").length,
    oldOptionsPresent: rows.filter((product) => product.readiness.issues.some((issue: string) => issue.includes("Old Shopify options"))).length,
    missingCollection: rows.filter((product) => product.readiness.issues.includes("Missing Stock Bags collection")).length,
  };

  return new Response(JSON.stringify({
    collectionInput,
    requiredTag,
    shopifyProductType,
    limit,
    debug: fetched.debug,
    totals,
    rows,
  }), { headers: { "Content-Type": "application/json" } });
}

export default function StockBagMigrationReport() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const defaults = {
    collectionInput: actionData?.collectionInput || DEFAULT_COLLECTION_ID,
    requiredTag: actionData?.requiredTag || DEFAULT_REQUIRED_TAG,
    shopifyProductType: actionData?.shopifyProductType || DEFAULT_PRODUCT_TYPE,
    limit: actionData?.limit || 250,
  };

  return (
    <main style={{ padding: 24, maxWidth: 1440, margin: "0 auto" }}>
      <section style={{ background: "linear-gradient(135deg, #11183a, #3b0b63)", color: "white", borderRadius: 16, padding: 24, marginBottom: 20 }}>
        <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.8 }}>GSO ERP STOCK BAG MIGRATION</div>
        <h1 style={{ margin: "6px 0 8px", fontSize: 34 }}>Post-Pipeline Verification Report</h1>
        <p style={{ margin: 0, maxWidth: 880 }}>
          Read-only scanner for the Stock Bags collection. Use this before any bulk ERP sync to confirm the pipeline finished cleanly.
        </p>
      </section>

      <section style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 14, padding: 16, marginBottom: 20 }}>
        <strong>Safety rule:</strong> this page only previews Shopify product readiness. It does not create, update, delete, sync, or map products.
      </section>

      <section style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 20 }}>
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6 }}>
            Stock Bags Collection ID
            <input name="collectionInput" defaultValue={defaults.collectionInput} style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            Required Tag
            <input name="requiredTag" defaultValue={defaults.requiredTag} style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            Shopify Product Type
            <input name="shopifyProductType" defaultValue={defaults.shopifyProductType} style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            Max Products To Scan
            <input name="limit" defaultValue={defaults.limit} style={inputStyle} />
          </label>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={isSubmitting} style={buttonStyle}>
              {isSubmitting ? "Scanning..." : "Run Read-Only Verification"}
            </button>
          </div>
        </Form>
      </section>

      {actionData ? (
        <>
          <section style={{ background: "white", border: "1px solid #bfdbfe", borderRadius: 14, padding: 16, marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>Migration Readiness Summary</h2>
            {actionData.debug.error ? <p style={{ color: "#b91c1c" }}>{actionData.debug.error}</p> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12 }}>
              <Stat label="Total Scanned" value={actionData.totals.scanned} />
              <Stat label="Tag Matched" value={actionData.totals.tagMatched} />
              <Stat label="Product Type Matched" value={actionData.totals.productTypeMatched} />
              <Stat label="Final Matched" value={actionData.totals.finalMatched} />
              <Stat label="ERP Ready" value={actionData.totals.erpReady} />
              <Stat label="Not Ready" value={actionData.totals.notReady} />
              <Stat label="Pending Cleanup" value={actionData.totals.pendingShopifyCleanup} />
              <Stat label="Needs Setup" value={actionData.totals.needsSetup} />
              <Stat label="Missing Product GID" value={actionData.totals.missingProductGid} />
              <Stat label="Missing Variant GID" value={actionData.totals.missingVariantGid} />
              <Stat label="Wrong Variant Count" value={actionData.totals.wrongVariantCount} />
              <Stat label="Default Variant Issues" value={actionData.totals.defaultVariantIssues} />
              <Stat label="Missing Handle" value={actionData.totals.missingHandle} />
              <Stat label="Not Active" value={actionData.totals.notActive} />
              <Stat label="Old Options Present" value={actionData.totals.oldOptionsPresent} />
              <Stat label="Missing Collection" value={actionData.totals.missingCollection} />
            </div>
          </section>

          <section style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ padding: 16, borderBottom: "1px solid #e5e7eb" }}>
              <h2 style={{ margin: 0 }}>Scanned Products</h2>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead style={{ background: "#f8fafc" }}>
                  <tr>
                    <Th>Status</Th>
                    <Th>Product</Th>
                    <Th>Handle</Th>
                    <Th>Type</Th>
                    <Th>Shopify Status</Th>
                    <Th>Variants</Th>
                    <Th>Base Variant</Th>
                    <Th>Issues</Th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.rows.length ? actionData.rows.map((product: any) => (
                    <tr key={product.id || product.handle || product.title} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <Td><Badge label={product.readiness.label} ready={product.readiness.ready} /></Td>
                      <Td>
                        <strong>{product.title || "Untitled"}</strong>
                        <div style={{ color: "#64748b", marginTop: 3 }}>{product.id || "Missing product GID"}</div>
                      </Td>
                      <Td>{product.handle || "Missing"}</Td>
                      <Td>{product.productType || "-"}</Td>
                      <Td>{product.status || "-"}</Td>
                      <Td>{product.totalVariants || 0}</Td>
                      <Td>{product.baseVariantTitle || "Missing"}</Td>
                      <Td>{product.readiness.issues.length ? product.readiness.issues.join("; ") : "None"}</Td>
                    </tr>
                  )) : (
                    <tr>
                      <Td colSpan={8}>No products scanned.</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

const inputStyle = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
};

const buttonStyle = {
  padding: "10px 16px",
  borderRadius: 8,
  border: 0,
  background: "#111827",
  color: "white",
  fontWeight: 800,
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
      <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function Badge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span style={{
      display: "inline-flex",
      padding: "4px 9px",
      borderRadius: 999,
      fontWeight: 800,
      fontSize: 12,
      background: ready ? "#dcfce7" : "#fef3c7",
      color: ready ? "#166534" : "#92400e",
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ textAlign: "left", padding: "12px 14px", color: "#334155", whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ padding: "12px 14px", verticalAlign: "top", whiteSpace: "nowrap" }}>{children}</td>;
}
