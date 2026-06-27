import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

const EXCLUDED_JAR_PRODUCT_TYPE = "jar_5oz_clear";

function cleanText(value: FormDataEntryValue | null | undefined) {
  return String(value || "").trim();
}

function nullableText(value: FormDataEntryValue | null | undefined) {
  const text = cleanText(value);
  return text.length ? text : null;
}

function normalizeGid(value: FormDataEntryValue | null | undefined, type: "Product" | "ProductVariant") {
  const text = nullableText(value);
  if (!text) return null;
  if (text.startsWith("gid://shopify/")) return text;

  const digitsOnly = text.replace(/[^0-9]/g, "");
  return digitsOnly ? `gid://shopify/${type}/${digitsOnly}` : text;
}

function intValue(value: FormDataEntryValue | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAllowedJarProductType(productType: string) {
  return productType.startsWith("jar_") && productType !== EXCLUDED_JAR_PRODUCT_TYPE;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const [profiles, products] = await Promise.all([
    db.productTypeProfile.findMany({
      where: {
        shop: session.shop,
        active: true,
        key: {
          startsWith: "jar_",
          not: EXCLUDED_JAR_PRODUCT_TYPE,
        },
      },
      orderBy: { key: "asc" },
    }),
    db.configuratorProduct.findMany({
      where: {
        shop: session.shop,
        productType: {
          startsWith: "jar_",
          not: EXCLUDED_JAR_PRODUCT_TYPE,
        },
      },
      orderBy: [{ productType: "asc" }, { title: "asc" }],
    }),
  ]);

  return { profiles, products };
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const productType = cleanText(formData.get("productType"));
  const title = cleanText(formData.get("title"));
  const shopifyHandle = nullableText(formData.get("shopifyHandle"));
  const shopifyProductGid = normalizeGid(formData.get("shopifyProductGid"), "Product");
  const shopifyVariantGid = normalizeGid(formData.get("shopifyVariantGid"), "ProductVariant");
  const sku = nullableText(formData.get("sku"));
  const notes = nullableText(formData.get("notes"));
  const active = cleanText(formData.get("active")) !== "false";

  if (!isAllowedJarProductType(productType)) {
    return { ok: false, message: "Select an active jar product type. 5oz clear is excluded from storefront mapping." };
  }

  if (!title) {
    return { ok: false, message: "Title is required." };
  }

  if (!shopifyHandle && !shopifyProductGid) {
    return { ok: false, message: "Enter at least one Shopify handle or product GID." };
  }

  const profile = await db.productTypeProfile.findFirst({
    where: {
      shop: session.shop,
      key: productType,
      active: true,
    },
  });

  const minQuantity = intValue(formData.get("minQuantity"), Number(profile?.minQuantity || 128));
  const existing = await db.configuratorProduct.findFirst({
    where: {
      shop: session.shop,
      title,
    },
  });

  const data = {
    title,
    productType,
    shopifyHandle,
    shopifyProductGid,
    shopifyVariantGid,
    sku,
    minQuantity,
    defaultSides: "Jar Label Set",
    pilot: false,
    active,
    notes,
  };

  if (existing) {
    await db.configuratorProduct.update({
      where: { id: existing.id },
      data,
    });
    return { ok: true, message: `Updated jar configurator product: ${title}.` };
  }

  await db.configuratorProduct.create({
    data: {
      shop: session.shop,
      ...data,
    },
  });

  return { ok: true, message: `Created jar configurator product: ${title}.` };
}

export default function ConfiguratorJarMapping() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const firstProfile = data.profiles[0];

  return (
    <div className="gso-page">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      <div className="page-head">
        <div>
          <p className="eyebrow">GSO ERP</p>
          <h1>Jar Configurator Mapping</h1>
          <p className="muted">Manually link an existing Shopify jar product to a jar ConfiguratorProduct row.</p>
        </div>
        <div className="links">
          <Link to="/app/erp/configurator?productFamily=jars">Jar Calculator</Link>
          <Link to="/app">App Home</Link>
        </div>
      </div>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice success" : "notice warning"}>{actionData.message}</div>
      ) : null}

      <div className="card">
        <h2>Create or Update Jar Mapping</h2>
        <Form method="post" className="form-grid">
          <label>
            Jar Product Type
            <select name="productType" defaultValue={firstProfile?.key || ""} required>
              {data.profiles.map((profile: any) => (
                <option key={profile.key} value={profile.key}>
                  {profile.name} ({profile.key})
                </option>
              ))}
            </select>
          </label>

          <label>
            ERP Title
            <input name="title" required placeholder="50ml Jar - Existing Shopify Product" />
          </label>

          <label>
            Shopify Handle
            <input name="shopifyHandle" placeholder="50ml-applied-label-jar" />
          </label>

          <label>
            Shopify Product GID or ID
            <input name="shopifyProductGid" placeholder="gid://shopify/Product/123456789 or 123456789" />
          </label>

          <label>
            Shopify Variant GID or ID
            <input name="shopifyVariantGid" placeholder="gid://shopify/ProductVariant/123456789 or 123456789" />
          </label>

          <label>
            SKU
            <input name="sku" placeholder="JAR-50ML-LABEL" />
          </label>

          <label>
            Min Quantity
            <input name="minQuantity" type="number" min="1" defaultValue={firstProfile?.minQuantity || 128} />
          </label>

          <label className="wide">
            Notes
            <textarea name="notes" placeholder="Manual jar storefront mapping notes." />
          </label>

          <label className="checkbox-row">
            <input type="hidden" name="active" value="false" />
            <input type="checkbox" name="active" value="true" defaultChecked />
            Active in storefront configurator
          </label>

          <div className="button-row">
            <button type="submit" disabled={isSubmitting || !data.profiles.length}>
              {isSubmitting ? "Saving..." : "Save Jar Mapping"}
            </button>
          </div>
        </Form>
      </div>

      <div className="card">
        <h2>Existing Jar Configurator Products</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Product Type</th>
                <th>Active</th>
                <th>Handle</th>
                <th>Product GID</th>
                <th>Variant GID</th>
                <th>SKU</th>
                <th>Min Qty</th>
              </tr>
            </thead>
            <tbody>
              {data.products.length ? (
                data.products.map((product: any) => (
                  <tr key={product.id}>
                    <td>{product.title}</td>
                    <td>{product.productType}</td>
                    <td>{product.active ? "Yes" : "No"}</td>
                    <td>{product.shopifyHandle || "-"}</td>
                    <td>{product.shopifyProductGid || "-"}</td>
                    <td>{product.shopifyVariantGid || "-"}</td>
                    <td>{product.sku || "-"}</td>
                    <td>{product.minQuantity}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8}>No jar ConfiguratorProduct rows found yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const styles = `
.gso-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
  color: #202223;
}
.page-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  margin-bottom: 20px;
}
.page-head h1 {
  margin: 0 0 8px;
  font-size: 32px;
}
.eyebrow {
  margin: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 12px;
  font-weight: 700;
  color: #5c5f62;
}
.muted {
  color: #6d7175;
  margin: 0;
}
.links {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.links a,
button {
  border: 1px solid #8c9196;
  border-radius: 6px;
  background: #ffffff;
  color: #202223;
  padding: 9px 12px;
  text-decoration: none;
  font-weight: 650;
}
button {
  cursor: pointer;
  background: #008060;
  color: #ffffff;
  border-color: #008060;
}
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.notice {
  border-radius: 6px;
  padding: 12px 14px;
  margin-bottom: 16px;
  border: 1px solid #d0d5dd;
}
.notice.success {
  background: #ecfdf3;
  border-color: #abefc6;
}
.notice.warning {
  background: #fffaeb;
  border-color: #fedf89;
}
.card {
  background: #ffffff;
  border: 1px solid #dfe3e8;
  border-radius: 8px;
  padding: 18px;
  margin-bottom: 18px;
}
.card h2 {
  margin: 0 0 14px;
  font-size: 20px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 650;
}
input,
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #c9cccf;
  border-radius: 6px;
  padding: 9px 10px;
  font: inherit;
}
textarea {
  min-height: 88px;
}
.wide {
  grid-column: 1 / -1;
}
.checkbox-row {
  flex-direction: row;
  align-items: center;
  font-weight: 500;
}
.checkbox-row input[type="checkbox"] {
  width: auto;
}
.button-row {
  display: flex;
  align-items: end;
  justify-content: flex-end;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  border-bottom: 1px solid #e1e3e5;
  padding: 9px 8px;
  text-align: left;
  vertical-align: top;
}
th {
  background: #f6f6f7;
  font-weight: 700;
}
@media (max-width: 760px) {
  .page-head,
  .form-grid {
    display: block;
  }
  label,
  .button-row,
  .links {
    margin-top: 12px;
  }
}
`;
