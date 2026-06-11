import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

const PRODUCT_TYPE = "stock_bag_4x5";

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value || "").trim();
  return text.length ? text : null;
}

function normalizeGid(value: FormDataEntryValue | null, type: "Product" | "ProductVariant") {
  const text = cleanText(value);
  if (!text) return null;

  if (text.startsWith("gid://shopify/")) return text;

  const digitsOnly = text.replace(/[^0-9]/g, "");
  if (digitsOnly) return `gid://shopify/${type}/${digitsOnly}`;

  return text;
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "saveMapping") {
    return { ok: false, message: "No action taken." };
  }

  const id = String(formData.get("id") || "");
  if (!id) {
    return { ok: false, message: "Missing configurator product ID." };
  }

  const existing = await db.configuratorProduct.findFirst({
    where: {
      id,
      shop: session.shop,
      productType: PRODUCT_TYPE,
    },
  });

  if (!existing) {
    return { ok: false, message: "Configurator product was not found for this shop." };
  }

  const shopifyProductGid = normalizeGid(formData.get("shopifyProductGid"), "Product");
  const shopifyVariantGid = normalizeGid(formData.get("shopifyVariantGid"), "ProductVariant");
  const shopifyHandle = cleanText(formData.get("shopifyHandle"));
  const sku = cleanText(formData.get("sku"));
  const notes = cleanText(formData.get("notes"));
  const active = String(formData.get("active") || "") === "on";

  await db.configuratorProduct.update({
    where: { id },
    data: {
      shopifyProductGid,
      shopifyVariantGid,
      shopifyHandle,
      sku,
      notes,
      active,
    },
  });

  return {
    ok: true,
    message: `Saved Shopify mapping for ${existing.title}.`,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const products = await db.configuratorProduct.findMany({
    where: {
      shop: session.shop,
      productType: PRODUCT_TYPE,
    },
    orderBy: [{ pilot: "desc" }, { title: "asc" }],
  });

  const mappedCount = products.filter((product) => product.shopifyProductGid || product.shopifyHandle).length;
  const fullyMappedCount = products.filter((product) => product.shopifyProductGid && product.shopifyVariantGid).length;

  return {
    shop: session.shop,
    products,
    mappedCount,
    fullyMappedCount,
    totalCount: products.length,
  };
}

export default function ConfiguratorMapping() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <div className="gso-page">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      <div className="hero">
        <div>
          <p className="eyebrow">GSO ERP Pilot</p>
          <h1>Manual Mapping / Exceptions</h1>
          <p>
            Fallback screen for manually fixing unusual Shopify product mappings. Collection/tag sync will be the main workflow for large catalogs.
            This keeps Shopify lightweight while ERP owns pricing, cost, margin, and production rules.
          </p>
        </div>
        <div className="hero-card">
          <strong>Mapping Status</strong>
          <span>{data.mappedCount}/{data.totalCount} have product mapping</span>
          <span>{data.fullyMappedCount}/{data.totalCount} have product + variant mapping</span>
          <span>Product type: 4x5 stock bag</span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice success" : "notice warning"}>{actionData.message}</div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Manual Pilot Mapping / Exceptions</h2>
            <p className="muted">
              Use this only for exceptions or manual corrections. The next sync workflow will map products by Shopify collection and tag.
              You can paste either the full Shopify GID or just the numeric ID.
            </p>
          </div>
          <a className="link-button" href="/app/erp/configurator">Back to Configurator</a>
        </div>
      </div>

      <div className="mapping-list">
        {data.products.map((product: any) => (
          <div className="card mapping-card" key={product.id}>
            <div className="mapping-title">
              <div>
                <h3>{product.title}</h3>
                <p className="muted">
                  Min Qty: {product.minQuantity} · Sides: {product.defaultSides} · Pilot: {product.pilot ? "Yes" : "No"}
                </p>
              </div>
              <div className={product.shopifyProductGid && product.shopifyVariantGid ? "status good" : "status needs"}>
                {product.shopifyProductGid && product.shopifyVariantGid ? "Mapped" : "Needs Mapping"}
              </div>
            </div>

            <Form method="post" className="form-grid">
              <input type="hidden" name="intent" value="saveMapping" />
              <input type="hidden" name="id" value={product.id} />

              <label>
                Shopify Product GID or ID
                <input
                  name="shopifyProductGid"
                  defaultValue={product.shopifyProductGid || ""}
                  placeholder="gid://shopify/Product/123456789 or 123456789"
                />
              </label>

              <label>
                Shopify Base Variant GID or ID
                <input
                  name="shopifyVariantGid"
                  defaultValue={product.shopifyVariantGid || ""}
                  placeholder="gid://shopify/ProductVariant/123456789 or 123456789"
                />
              </label>

              <label>
                Shopify Handle
                <input
                  name="shopifyHandle"
                  defaultValue={product.shopifyHandle || ""}
                  placeholder="ritz-vanilla-cupcake"
                />
              </label>

              <label>
                Base SKU
                <input
                  name="sku"
                  defaultValue={product.sku || ""}
                  placeholder="GSO-STOCK-RITZ-VANILLA-CUPCAKE"
                />
              </label>

              <label className="wide">
                Notes
                <textarea
                  name="notes"
                  defaultValue={product.notes || ""}
                  placeholder="Mapping notes, product cleanup notes, or migration status."
                />
              </label>

              <label className="checkbox-row">
                <input type="checkbox" name="active" defaultChecked={product.active} />
                Active in configurator
              </label>

              <div className="button-row">
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save Mapping"}
                </button>
              </div>
            </Form>

            <div className="current-values">
              <p><b>Current Product GID:</b> {product.shopifyProductGid || "Not set"}</p>
              <p><b>Current Variant GID:</b> {product.shopifyVariantGid || "Not set"}</p>
              <p><b>Current Handle:</b> {product.shopifyHandle || "Not set"}</p>
              <p><b>Current SKU:</b> {product.sku || "Not set"}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>What This Unlocks Next</h2>
        <ol>
          <li>ERP can generate product-specific config IDs.</li>
          <li>Shopify product page can load the right configurator settings by product ID or handle.</li>
          <li>Line item properties can include ERP Product ID, Material, Finish, Bag Color, and Quantity.</li>
          <li>Order paid webhook can match Shopify order items back to ERP production rules.</li>
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
.card-head,
.mapping-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.card h2,
.mapping-title h3 {
  margin-top: 0;
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
.mapping-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}
.mapping-card {
  margin-bottom: 0;
}
.status {
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.status.good {
  background: #ecfdf3;
  color: #14532d;
  border: 1px solid #86efac;
}
.status.needs {
  background: #fff4e5;
  color: #7a4b00;
  border: 1px solid #ffb84d;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 16px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 650;
}
input,
textarea {
  min-height: 42px;
  border: 1px solid #c9cccf;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 14px;
}
textarea {
  min-height: 80px;
}
.wide {
  grid-column: span 2;
}
.checkbox-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.checkbox-row input {
  min-height: auto;
}
.button-row {
  display: flex;
  align-items: end;
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
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.current-values {
  margin-top: 16px;
  background: #f9fafb;
  border-radius: 12px;
  padding: 12px;
}
.current-values p {
  margin: 6px 0;
  word-break: break-word;
}
@media (max-width: 900px) {
  .hero,
  .card-head,
  .mapping-title,
  .form-grid {
    grid-template-columns: 1fr;
    display: grid;
  }
  .wide {
    grid-column: span 1;
  }
}
`;

