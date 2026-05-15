import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function normalize(value: any) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function selectedOptionsText(options: any[] = []) {
  return (options || []).map((option) => `${option?.name || ""}: ${option?.value || ""}`).join(" / ");
}

function matchesAny(text: string, terms: string[]) {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function pickSideModeFromVariantText(text: string) {
  const normalized = normalize(text);
  const isDouble = matchesAny(normalized, ["double sided", "2 sided", "two sided", "front back", "both sides", "double side"]);
  const isSingle = matchesAny(normalized, ["single sided", "1 sided", "one sided", "front only", "single side"]);

  if (isDouble) {
    return { sideMode: "double_same", useFrontZone: true, useBackZone: true, backMediaMode: "same_as_front" };
  }
  if (isSingle) {
    return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
  }
  return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
}

function mediaAliasesForOption(option: any) {
  const values = [option?.name, option?.material?.name, option?.notes];
  const text = values.filter(Boolean).join(" ");
  const aliases = new Set<string>();
  if (text) aliases.add(text);

  if (matchesAny(text, ["holographic", "holo"])) {
    ["holographic", "holo", "premium"].forEach((value) => aliases.add(value));
  }
  if (matchesAny(text, ["matte", "matt"])) {
    ["matte", "matt"].forEach((value) => aliases.add(value));
  }
  if (matchesAny(text, ["gloss", "glossy"])) {
    ["gloss", "glossy"].forEach((value) => aliases.add(value));
  }

  return Array.from(aliases);
}

function pickMediaOptionFromVariantText(text: string, mediaOptions: any[] = []) {
  const activeOptions = (mediaOptions || []).filter((option: any) => option.active !== false);
  const normalized = normalize(text);

  const directTerms = [
    { terms: ["holographic", "holo"], keyword: "holo" },
    { terms: ["matte", "matt"], keyword: "matte" },
    { terms: ["gloss", "glossy"], keyword: "gloss" },
  ];

  for (const group of directTerms) {
    if (group.terms.some((term) => normalized.includes(normalize(term)))) {
      const match = activeOptions.find((option: any) => mediaAliasesForOption(option).some((alias) => normalize(alias).includes(group.keyword)));
      if (match) return match;
    }
  }

  for (const option of activeOptions) {
    if (mediaAliasesForOption(option).some((alias) => normalized.includes(normalize(alias)))) return option;
  }

  return activeOptions.find((option: any) => option.defaultOption) || activeOptions[0] || null;
}

function pickBagColorFromSelectedOptions(selectedOptions: any[] = [], text = "") {
  const colorTerms = [
    "black", "white", "clear", "gold", "silver", "red", "blue", "green", "purple", "pink",
    "orange", "yellow", "brown", "kraft", "mylar", "mixed", "assorted"
  ];

  for (const option of selectedOptions || []) {
    const optionName = normalize(option?.name);
    const optionValue = String(option?.value || "").trim();
    const normalizedValue = normalize(optionValue);
    if (!optionValue) continue;
    if (optionName.includes("color") || optionName.includes("colour") || optionName.includes("bag")) return optionValue;
    if (colorTerms.some((color) => normalizedValue === normalize(color) || normalizedValue.includes(normalize(color)))) return optionValue;
  }

  const normalizedText = normalize(text);
  const found = colorTerms.find((color) => normalizedText.includes(normalize(color)));
  return found ? found.replace(/\b\w/g, (char) => char.toUpperCase()) : "Any";
}

function autoMapShopifyVariant(variant: any, recipe: any) {
  const selectedOptions = variant?.selectedOptions || [];
  const text = `${variant?.title || ""} / ${selectedOptionsText(selectedOptions)} / ${variant?.sku || ""}`;
  const side = pickSideModeFromVariantText(text);
  const mediaOption = pickMediaOptionFromVariantText(text, recipe?.mediaOptions || []);
  const bagColor = pickBagColorFromSelectedOptions(selectedOptions, text);

  const needsReview: string[] = [];
  if (!mediaOption) needsReview.push("media option");
  if (bagColor === "Any" && matchesAny(text, ["color", "colour", "bag color"])) needsReview.push("bag color");

  return {
    name: variant?.title ? `Auto - ${variant.title}` : "Auto-mapped Shopify variant",
    shopifyVariantTitle: variant?.title || "",
    sku: variant?.sku || "",
    sideMode: side.sideMode,
    bagColor,
    frontMediaOptionId: mediaOption?.id || null,
    backMediaMode: side.backMediaMode,
    backMediaOptionId: null,
    useFrontZone: side.useFrontZone,
    useBackZone: side.useBackZone,
    notes: needsReview.length
      ? `Auto-synced from Shopify Links. Needs review: ${needsReview.join(", ")}. Quantities are handled by pricing templates, not Shopify variants.`
      : "Auto-synced from Shopify Links. Quantities are handled by pricing templates, not Shopify variants.",
  };
}

async function searchShopifyProducts(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query ProductRecipeProductSearch($query: String!) {
        products(first: 10, query: $query) {
          edges {
            node {
              id
              title
              handle
              totalVariants
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: safeQuery } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  return payload?.data?.products?.edges?.map((edge: any) => ({
    ...edge.node,
    sampleVariants: edge.node?.variants?.edges?.map((variantEdge: any) => variantEdge.node) || [],
  })) || [];
}

async function searchShopifyCollections(admin: any, query: string) {
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const response = await admin.graphql(
    `#graphql
      query ProductRecipeCollectionSearch($query: String!) {
        collections(first: 10, query: $query) {
          edges {
            node {
              id
              title
              handle
              products(first: 10) {
                edges {
                  node {
                    id
                    title
                    handle
                    totalVariants
                    variants(first: 3) {
                      edges { node { id title sku price selectedOptions { name value } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: safeQuery } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  return payload?.data?.collections?.edges?.map((edge: any) => ({
    ...edge.node,
    products: edge.node?.products?.edges?.map((productEdge: any) => ({
      ...productEdge.node,
      sampleVariants: productEdge.node?.variants?.edges?.map((variantEdge: any) => variantEdge.node) || [],
    })) || [],
  })) || [];
}

async function fetchShopifyProductVariants(admin: any, productGid: string) {
  const response = await admin.graphql(
    `#graphql
      query ProductRecipeVariantSync($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          totalVariants
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                selectedOptions { name value }
              }
            }
          }
        }
      }
    `,
    { variables: { id: productGid } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  const product = payload?.data?.product;
  return { product, variants: product?.variants?.edges?.map((edge: any) => edge.node) || [] };
}

async function syncProductToRecipe(shop: string, recipe: any, admin: any, productGid: string) {
  const prisma: any = db;
  const { product, variants } = await fetchShopifyProductVariants(admin, productGid);
  if (!product) return { product: null, variants: [], created: 0, updated: 0 };

  let created = 0;
  let updated = 0;

  for (const variant of variants) {
    const mapped = autoMapShopifyVariant(variant, recipe);
    const existing = await prisma.recipeVariantRule.findFirst({
      where: { shop, recipeId: recipe.id, shopifyVariantGid: variant.id },
    });

    const data = {
      name: mapped.name,
      shopifyProductGid: product.id,
      shopifyVariantGid: variant.id,
      shopifyVariantTitle: mapped.shopifyVariantTitle,
      sku: mapped.sku,
      sideMode: mapped.sideMode,
      bagColor: mapped.bagColor,
      frontMediaOptionId: mapped.frontMediaOptionId,
      backMediaMode: mapped.backMediaMode,
      backMediaOptionId: mapped.backMediaOptionId,
      useFrontZone: mapped.useFrontZone,
      useBackZone: mapped.useBackZone,
      active: true,
      notes: mapped.notes,
    };

    if (existing) {
      await prisma.recipeVariantRule.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.recipeVariantRule.create({ data: { shop, recipeId: recipe.id, ...data } });
      created += 1;
    }
  }

  await prisma.productRecipe.updateMany({
    where: { shop, id: recipe.id, OR: [{ productGid: null }, { productGid: "" }] },
    data: { productGid: product.id },
  });

  return { product, variants, created, updated };
}

function productSampleText(product: any) {
  const samples = (product?.sampleVariants || []).map((variant: any) => [variant.title, variant.sku].filter(Boolean).join(" / ")).filter(Boolean);
  return samples.length ? samples.join("; ") : "No sample variants returned";
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const prisma: any = db;

  const recipes = await prisma.productRecipe.findMany({
    where: { shop, active: true },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    include: {
      mediaOptions: { include: { material: true }, orderBy: [{ active: "desc" }, { name: "asc" }] },
      variantRules: { orderBy: [{ active: "desc" }, { name: "asc" }] },
    },
  });

  return Response.json({ recipes });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const prisma: any = db;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "searchProducts") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return Response.json({ ok: false, message: "Enter a Shopify product name or SKU." }, { status: 400 });
      const results = await searchShopifyProducts(admin, query);
      return Response.json({ ok: true, intent, message: results.length ? `Found ${results.length} product(s).` : "No products found.", query, productResults: results });
    }

    if (intent === "searchCollections") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return Response.json({ ok: false, message: "Enter a Shopify collection name." }, { status: 400 });
      const results = await searchShopifyCollections(admin, query);
      return Response.json({ ok: true, intent, message: results.length ? `Found ${results.length} collection(s).` : "No collections found.", query, collectionResults: results });
    }

    if (intent === "syncProduct") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGid = String(formData.get("productGid") || "");
      if (!recipeId || !productGid) return Response.json({ ok: false, message: "Missing recipe or Shopify product." }, { status: 400 });
      const recipe = await prisma.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { mediaOptions: { include: { material: true } } } });
      if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });
      const result = await syncProductToRecipe(shop, recipe, admin, productGid);
      if (!result.product) return Response.json({ ok: false, message: "Shopify product not found." }, { status: 404 });
      return Response.json({ ok: true, intent, message: `Synced ${result.product.title}: ${result.variants.length} variant(s), ${result.created} created, ${result.updated} updated.` });
    }

    if (intent === "syncCollection") {
      const recipeId = String(formData.get("recipeId") || "");
      const productGids = String(formData.get("productGids") || "").split(",").map((value) => value.trim()).filter(Boolean);
      if (!recipeId || !productGids.length) return Response.json({ ok: false, message: "Missing recipe or collection products." }, { status: 400 });
      const recipe = await prisma.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { mediaOptions: { include: { material: true } } } });
      if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

      let products = 0;
      let variants = 0;
      let created = 0;
      let updated = 0;
      for (const productGid of productGids.slice(0, 20)) {
        const result = await syncProductToRecipe(shop, recipe, admin, productGid);
        if (result.product) products += 1;
        variants += result.variants.length;
        created += result.created;
        updated += result.updated;
      }
      return Response.json({ ok: true, intent, message: `Synced ${products} product(s) from collection: ${variants} variant(s), ${created} created, ${updated} updated.` });
    }

    if (intent === "hideRule" || intent === "restoreRule") {
      const ruleId = String(formData.get("ruleId") || "");
      await prisma.recipeVariantRule.updateMany({ where: { shop, id: ruleId }, data: { active: intent === "restoreRule" } });
      return Response.json({ ok: true, message: intent === "restoreRule" ? "Variant mapping restored." : "Variant mapping hidden." });
    }

    if (intent === "deleteRule") {
      const ruleId = String(formData.get("ruleId") || "");
      await prisma.recipeVariantRule.deleteMany({ where: { shop, id: ruleId } });
      return Response.json({ ok: true, message: "Variant mapping deleted." });
    }

    return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("Shopify Links action failed", error);
    return Response.json({ ok: false, message: error?.message || "Shopify link action failed." }, { status: 500 });
  }
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: "green" | "yellow" | "red" | "neutral" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export default function ShopifyLinksPage() {
  const { recipes } = useLoaderData<any>();
  const actionData = useActionData<any>();

  return <main className="page">
    <header className="hero">
      <h1>Shopify Product / Collection Links</h1>
      <p>Safely connect Shopify products and collections to product recipes without touching the Recipe Builder page.</p>
    </header>

    {actionData?.message ? <div className={`notice ${actionData.ok ? "success" : "error"}`}>{actionData.message}</div> : null}

    <section className="grid two">
      <div className="card">
        <h2>Search Shopify products</h2>
        <p className="muted">Use this for individual products like 4x5 Custom Sticker Bags or 4x5 Stock Bags.</p>
        <Form method="post" className="row">
          <input type="hidden" name="intent" value="searchProducts" />
          <input name="query" defaultValue={actionData?.intent === "searchProducts" ? actionData.query : ""} placeholder="Example: 4x5 sticker bag" />
          <button type="submit">Search products</button>
        </Form>
      </div>

      <div className="card">
        <h2>Search Shopify collections</h2>
        <p className="muted">Use this when a full collection should use the same recipe.</p>
        <Form method="post" className="row">
          <input type="hidden" name="intent" value="searchCollections" />
          <input name="query" defaultValue={actionData?.intent === "searchCollections" ? actionData.query : ""} placeholder="Example: Stock Bags" />
          <button type="submit">Search collections</button>
        </Form>
      </div>
    </section>

    {actionData?.productResults?.length ? <section className="card wide">
      <h2>Product results</h2>
      <table>
        <thead><tr><th>Shopify product</th><th>Sample variants</th><th>Link to recipe</th></tr></thead>
        <tbody>
          {actionData.productResults.map((product: any) => <tr key={product.id}>
            <td><strong>{product.title}</strong><br /><span className="muted">{product.handle} · {product.totalVariants || 0} variant(s)</span></td>
            <td>{productSampleText(product)}</td>
            <td>
              <Form method="post" className="stacked">
                <input type="hidden" name="intent" value="syncProduct" />
                <input type="hidden" name="productGid" value={product.id} />
                <select name="recipeId" required defaultValue="">
                  <option value="" disabled>Choose recipe</option>
                  {recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.productFamily || recipe.productTypeProfile?.name || "Recipe"}</option>)}
                </select>
                <button type="submit">Use this product + sync variants</button>
              </Form>
            </td>
          </tr>)}
        </tbody>
      </table>
    </section> : null}

    {actionData?.collectionResults?.length ? <section className="card wide">
      <h2>Collection results</h2>
      <table>
        <thead><tr><th>Collection</th><th>Products found</th><th>Link collection products to recipe</th></tr></thead>
        <tbody>
          {actionData.collectionResults.map((collection: any) => <tr key={collection.id}>
            <td><strong>{collection.title}</strong><br /><span className="muted">{collection.handle}</span></td>
            <td>{collection.products?.length ? collection.products.map((product: any) => <div key={product.id}>{product.title} <span className="muted">({product.totalVariants || 0} variant/s)</span></div>) : "No products returned"}</td>
            <td>
              <Form method="post" className="stacked">
                <input type="hidden" name="intent" value="syncCollection" />
                <input type="hidden" name="productGids" value={(collection.products || []).map((product: any) => product.id).join(",")} />
                <select name="recipeId" required defaultValue="">
                  <option value="" disabled>Choose recipe</option>
                  {recipes.map((recipe: any) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.productFamily || recipe.productTypeProfile?.name || "Recipe"}</option>)}
                </select>
                <button type="submit">Sync collection products</button>
              </Form>
            </td>
          </tr>)}
        </tbody>
      </table>
    </section> : null}

    <section className="card wide">
      <h2>Recipe links / saved variant mappings</h2>
      <p className="muted">Quantity tiers are not stored as Shopify variants. Tiers stay controlled by each recipe pricing template.</p>
      {recipes.map((recipe: any) => <details key={recipe.id} className="recipe-card">
        <summary><strong>{recipe.name}</strong> <Badge tone="green">{(recipe.variantRules || []).filter((rule: any) => rule.active !== false).length} active mappings</Badge></summary>
        <div className="recipe-body">
          <p><strong>Default Shopify product:</strong> {recipe.productGid || <span className="muted">Not set yet</span>}</p>
          <p><strong>Media options:</strong> {(recipe.mediaOptions || []).map((option: any) => option.name).join(", ") || "No media options"}</p>
          {(recipe.variantRules || []).length ? <table>
            <thead><tr><th>Variant</th><th>Product / SKU</th><th>Auto rules</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(recipe.variantRules || []).map((rule: any) => <tr key={rule.id}>
                <td><strong>{rule.name}</strong><br /><span className="muted">{rule.shopifyVariantTitle || "No Shopify title"}</span></td>
                <td><span className="muted">{rule.shopifyProductGid || "No product GID"}</span><br />{rule.sku ? `SKU: ${rule.sku}` : "No SKU"}</td>
                <td>
                  Side: {rule.sideMode || "single"}<br />
                  Color: {rule.bagColor || "Any"}<br />
                  Front media: {recipe.mediaOptions?.find((option: any) => option.id === rule.frontMediaOptionId)?.name || "Default"}<br />
                  Back: {rule.backMediaMode || "none"}
                </td>
                <td>{rule.active === false ? <Badge tone="yellow">Hidden</Badge> : <Badge tone="green">Active</Badge>}</td>
                <td>
                  <div className="button-row">
                    <Form method="post"><input type="hidden" name="intent" value={rule.active === false ? "restoreRule" : "hideRule"} /><input type="hidden" name="ruleId" value={rule.id} /><button type="submit" className="secondary">{rule.active === false ? "Restore" : "Hide"}</button></Form>
                    <Form method="post"><input type="hidden" name="intent" value="deleteRule" /><input type="hidden" name="ruleId" value={rule.id} /><button type="submit" className="danger">Delete</button></Form>
                  </div>
                </td>
              </tr>)}
            </tbody>
          </table> : <p className="muted">No synced variant mappings yet.</p>}
        </div>
      </details>)}
    </section>

    <style>{`
      .page { max-width: 1180px; margin: 0 auto; padding: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .hero { background: linear-gradient(135deg, #15121d, #421066); color: white; border-radius: 14px; padding: 22px; margin-bottom: 16px; }
      .hero h1 { margin: 0 0 6px; font-size: 28px; }
      .hero p { margin: 0; opacity: .9; }
      .grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
      .wide { width: 100%; }
      .muted { color: #666; font-size: 13px; }
      .notice { border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
      .success { background: #e8fff0; border: 1px solid #b8ebc8; }
      .error { background: #ffe8e8; border: 1px solid #efb8b8; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
      .stacked { display: grid; gap: 8px; }
      input, select, textarea { border: 1px solid #bbb; border-radius: 8px; padding: 9px 10px; font: inherit; }
      button { border: 0; border-radius: 8px; background: #111827; color: white; padding: 9px 12px; cursor: pointer; }
      button.secondary { background: #e5e7eb; color: #111827; }
      button.danger { background: #b91c1c; color: #fff; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; vertical-align: top; }
      th { font-size: 12px; color: #555; background: #fafafa; }
      .badge { display: inline-block; border-radius: 999px; padding: 3px 8px; font-size: 12px; margin-left: 6px; }
      .badge.green { background: #dcfce7; color: #166534; }
      .badge.yellow { background: #fef3c7; color: #92400e; }
      .badge.red { background: #fee2e2; color: #991b1b; }
      .badge.neutral { background: #eee; color: #333; }
      .recipe-card { border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; margin: 10px 0; }
      .recipe-body { padding-top: 10px; }
      .button-row { display: flex; gap: 8px; flex-wrap: wrap; }
      @media (max-width: 900px) { .grid.two { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr; } }
    `}</style>
  </main>;
}
