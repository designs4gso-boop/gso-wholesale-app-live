import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { Page, Layout, Card, Text, BlockStack, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getRules, createRule, deleteRule, getWholesaleConfig } from "../lib/wholesale.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [rules, config] = await Promise.all([
    getRules(session.shop),
    getWholesaleConfig(session.shop),
  ]);
  return data({ rules, config });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "create_rule") {
    const title = String(formData.get("title") || "").trim();
    const customerTag = String(formData.get("customerTag") || "").trim();
    const scopeType = String(formData.get("scopeType") || "GLOBAL").toUpperCase();
    const scopeId = String(formData.get("scopeId") || "").trim() || null;
    const scopeLabel = String(formData.get("scopeLabel") || "").trim() || null;
    const discountType = String(formData.get("discountType") || "FIXED_PRICE").toUpperCase();
    const value = Number(formData.get("value") || 0);
    const minQuantity = Math.max(1, Number(formData.get("minQuantity") || 1));
    const minProductQuantity = formData.get("minProductQuantity")
      ? Math.max(1, Number(formData.get("minProductQuantity")))
      : null;
    const minCartQuantity = formData.get("minCartQuantity")
      ? Math.max(1, Number(formData.get("minCartQuantity")))
      : null;
    const minSubtotal = formData.get("minSubtotal")
      ? Number(formData.get("minSubtotal"))
      : null;

    if (!title) return data({ ok: false, error: "Title is required." });
    if (!customerTag) return data({ ok: false, error: "Customer tag is required." });

    await createRule(session.shop, {
      title,
      customerTag,
      scopeType,
      scopeId,
      scopeLabel,
      discountType,
      value,
      minQuantity,
      minProductQuantity,
      minCartQuantity,
      minSubtotal,
      active: formData.get("active") === "on",
    });

    return redirect("/app/wholesale/rules");
  }

  if (intent === "delete_rule") {
    await deleteRule(Number(formData.get("ruleId")));
    return redirect("/app/wholesale/rules");
  }

  return data({ ok: false, error: "Unknown action." });
}

export default function PricingRulesPage() {
  const { rules, config } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="Pricing rules" backAction={{ content: "Settings", url: "/app/wholesale" }}>
      <Layout>
        <Layout.Section>
          {actionData && "error" in actionData && actionData.error ? (
            <Banner tone="critical">{actionData.error}</Banner>
          ) : null}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Create wholesale rule</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="create_rule" />
                <BlockStack gap="300">
                  <label>Title<br /><input name="title" defaultValue="64 bag tier" /></label>
                  <label>Customer tag<br /><input name="customerTag" defaultValue={config.wholesaleTag} /></label>
                  <label>Scope type<br />
                    <select name="scopeType" defaultValue="GLOBAL">
                      <option value="GLOBAL">Global</option>
                      <option value="PRODUCT">Product</option>
                      <option value="VARIANT">Variant</option>
                      <option value="COLLECTION">Collection</option>
                    </select>
                  </label>
                  <label>Scope ID (optional)<br /><input name="scopeId" placeholder="gid://shopify/Product/..." /></label>
                  <label>Scope label (optional)<br /><input name="scopeLabel" placeholder="Starter pack bags" /></label>
                  <label>Discount type<br />
                    <select name="discountType" defaultValue="FIXED_PRICE">
                      <option value="FIXED_PRICE">Fixed price</option>
                      <option value="PERCENT_OFF">Percent off</option>
                      <option value="AMOUNT_OFF">Amount off</option>
                    </select>
                  </label>
                  <label>Value<br /><input name="value" type="number" step="0.01" defaultValue="0.65" /></label>
                  <label>Tier starts at quantity<br /><input name="minQuantity" type="number" min="1" defaultValue="64" /></label>
                  <label>Minimum product quantity (optional)<br /><input name="minProductQuantity" type="number" min="1" defaultValue="64" /></label>
                  <label>Minimum total cart quantity (optional)<br /><input name="minCartQuantity" type="number" min="1" /></label>
                  <label>Minimum subtotal (optional)<br /><input name="minSubtotal" type="number" step="0.01" /></label>
                  <label><input name="active" type="checkbox" defaultChecked /> Active</label>
                  <Button submit variant="primary" loading={saving}>Create rule</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Existing rules</Text>
              {rules.length === 0 ? <Text as="p" variant="bodyMd">No rules yet.</Text> : null}
              {rules.map((rule: any) => (
                <Card key={rule.id}>
                  <BlockStack gap="150">
                    <Text as="p" variant="bodyMd"><strong>{rule.title}</strong></Text>
                    <Text as="p" variant="bodySm">Tag: {rule.customerTag}</Text>
                    <Text as="p" variant="bodySm">Scope: {rule.scopeType} {rule.scopeLabel || rule.scopeId || "all products"}</Text>
                    <Text as="p" variant="bodySm">Tier start: {rule.minQuantity}+</Text>
                    <Text as="p" variant="bodySm">MOQ: {rule.minProductQuantity || "none"}</Text>
                    <Text as="p" variant="bodySm">Min cart qty: {rule.minCartQuantity || "none"}</Text>
                    <Text as="p" variant="bodySm">Min subtotal: {rule.minSubtotal || "none"}</Text>
                    <Text as="p" variant="bodySm">Discount: {rule.discountType} {rule.value}</Text>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete_rule" />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <Button submit tone="critical">Delete</Button>
                    </Form>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}