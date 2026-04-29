import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Badge,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getRules,
  createRule,
  deleteRule,
  getWholesaleConfig,
} from "../lib/wholesale.server";

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

    if (!title) return data({ ok: false, error: "Rule title is required." });
    if (!customerTag) return data({ ok: false, error: "Customer tag is required." });
    if (!value || value <= 0) return data({ ok: false, error: "Discount value must be greater than 0." });

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

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <label style={{ display: "block" }}>
      <Text as="p" variant="bodyMd" fontWeight="semibold">
        {label}
      </Text>
      <div style={{ marginTop: 6 }}>{children}</div>
      {help ? (
        <div style={{ marginTop: 4 }}>
          <Text as="p" variant="bodySm" tone="subdued">
            {help}
          </Text>
        </div>
      ) : null}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #c9cccf",
  borderRadius: 8,
  fontSize: 14,
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
  gap: 16,
};

export default function PricingRulesPage() {
  const { rules, config } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const activeRules = rules.filter((rule: any) => rule.active).length;

  return (
    <Page
      title="Pricing Rules"
      subtitle="Create customer-tag based wholesale pricing, quantity breaks, MOQs, and product-specific rules."
      backAction={{ content: "Wholesale", url: "/app/wholesale" }}
      primaryAction={{
        content: "View storefront test product",
        url: "https://942075-2.myshopify.com/products/ritz-vanilla-cupcake",
        external: true,
      }}
    >
      <Layout>
        <Layout.Section>
          {actionData && "error" in actionData && actionData.error ? (
            <Banner tone="critical">
              <Text as="p">{actionData.error}</Text>
            </Banner>
          ) : null}

          <div style={{ marginBottom: 16 }}>
            <InlineStack gap="300" wrap>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Total rules</Text>
                  <Text as="h2" variant="headingLg">{rules.length}</Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Active rules</Text>
                  <Text as="h2" variant="headingLg">{activeRules}</Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Default wholesale tag</Text>
                  <Text as="h2" variant="headingMd">{config.wholesaleTag || "wholesale"}</Text>
                </BlockStack>
              </Card>
            </InlineStack>
          </div>

          <Card>
            <BlockStack gap="500">
              <BlockStack gap="150">
                <Text as="h2" variant="headingLg">
                  Create wholesale rule
                </Text>
                <Text as="p" tone="subdued">
                  Build pricing rules like Wholesale Gorilla: fixed wholesale prices, percent discounts, amount discounts, minimum order quantities, and customer-tag gating.
                </Text>
              </BlockStack>

              <Divider />

              <Form method="post">
                <input type="hidden" name="intent" value="create_rule" />

                <BlockStack gap="500">
                  <div style={gridStyle}>
                    <Field label="Rule title" help="Example: 64 bag wholesale tier">
                      <input style={inputStyle} name="title" defaultValue="64 bag wholesale tier" />
                    </Field>

                    <Field label="Customer tag" help="Customer must have this Shopify tag.">
                      <input style={inputStyle} name="customerTag" defaultValue={config.wholesaleTag || "wholesale"} />
                    </Field>
                  </div>

                  <div style={gridStyle}>
                    <Field label="Scope type" help="Choose where this rule applies.">
                      <select style={inputStyle} name="scopeType" defaultValue="GLOBAL">
                        <option value="GLOBAL">Global - all products</option>
                        <option value="PRODUCT">Product only</option>
                        <option value="VARIANT">Variant only</option>
                        <option value="COLLECTION">Collection</option>
                      </select>
                    </Field>

                    <Field label="Scope label" help="Friendly name shown in admin/debug box.">
                      <input style={inputStyle} name="scopeLabel" placeholder="Ritz Vanilla Cupcake" />
                    </Field>

                    <Field label="Scope ID" help="Optional for now. Use later for product/variant targeting.">
                      <input style={inputStyle} name="scopeId" placeholder="gid://shopify/Product/..." />
                    </Field>
                  </div>

                  <div style={gridStyle}>
                    <Field label="Discount type">
                      <select style={inputStyle} name="discountType" defaultValue="FIXED_PRICE">
                        <option value="FIXED_PRICE">Fixed wholesale price</option>
                        <option value="PERCENT_OFF">Percent off retail</option>
                        <option value="AMOUNT_OFF">Dollar amount off retail</option>
                      </select>
                    </Field>

                    <Field label="Value" help="Fixed price = final price. Percent = 20 for 20%. Amount = dollars off.">
                      <input style={inputStyle} name="value" type="number" step="0.01" defaultValue="0.65" />
                    </Field>

                    <Field label="Tier starts at quantity">
                      <input style={inputStyle} name="minQuantity" type="number" min="1" defaultValue="64" />
                    </Field>
                  </div>

                  <div style={gridStyle}>
                    <Field label="Minimum product quantity">
                      <input style={inputStyle} name="minProductQuantity" type="number" min="1" defaultValue="64" />
                    </Field>

                    <Field label="Minimum cart quantity">
                      <input style={inputStyle} name="minCartQuantity" type="number" min="1" placeholder="Optional" />
                    </Field>

                    <Field label="Minimum subtotal">
                      <input style={inputStyle} name="minSubtotal" type="number" step="0.01" placeholder="Optional" />
                    </Field>
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input name="active" type="checkbox" defaultChecked />
                    <Text as="span" variant="bodyMd">Rule is active</Text>
                  </label>

                  <InlineStack align="end">
                    <Button submit variant="primary" loading={saving}>
                      Create wholesale rule
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Existing rules</Text>
                  <Text as="p" tone="subdued">Rules are checked from highest matching tier down to the best customer price.</Text>
                </BlockStack>
                <Badge tone={rules.length ? "success" : "attention"}>
                  {rules.length ? `${rules.length} rules live` : "No rules"}
                </Badge>
              </InlineStack>

              <Divider />

              {rules.length === 0 ? (
                <EmptyState
                  heading="No wholesale rules yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Create your first rule above to start showing wholesale pricing on the storefront.</p>
                </EmptyState>
              ) : (
                <BlockStack gap="300">
                  {rules.map((rule: any) => (
                    <Card key={rule.id}>
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="start">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h3" variant="headingMd">{rule.title}</Text>
                              <Badge tone={rule.active ? "success" : "critical"}>
                                {rule.active ? "Active" : "Inactive"}
                              </Badge>
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              Customer tag: {rule.customerTag}
                            </Text>
                          </BlockStack>

                          <Form method="post">
                            <input type="hidden" name="intent" value="delete_rule" />
                            <input type="hidden" name="ruleId" value={rule.id} />
                            <Button submit tone="critical">
                              Delete
                            </Button>
                          </Form>
                        </InlineStack>

                        <Divider />

                        <div style={gridStyle}>
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">Scope</Text>
                            <Text as="p">{rule.scopeType} · {rule.scopeLabel || rule.scopeId || "All products"}</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">Discount</Text>
                            <Text as="p">{rule.discountType} · {rule.value}</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">Tier starts</Text>
                            <Text as="p">{rule.minQuantity}+</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">MOQ</Text>
                            <Text as="p">{rule.minProductQuantity || "None"}</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">Min cart qty</Text>
                            <Text as="p">{rule.minCartQuantity || "None"}</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">Min subtotal</Text>
                            <Text as="p">{rule.minSubtotal ? `$${rule.minSubtotal}` : "None"}</Text>
                          </BlockStack>
                        </div>
                      </BlockStack>
                    </Card>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}