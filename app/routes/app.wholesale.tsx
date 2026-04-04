import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Page, Layout, Card, Text, BlockStack, TextField, Button, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getWholesaleConfig, saveWholesaleConfig } from "../lib/wholesale.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const config = await getWholesaleConfig(session.shop);
  return data({ config, shop: session.shop });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  await saveWholesaleConfig(session.shop, {
    wholesaleTag: String(formData.get("wholesaleTag") || "wholesale_approved").trim(),
    pendingTag: String(formData.get("pendingTag") || "wholesale_pending").trim(),
    vipTag: String(formData.get("vipTag") || "vip_wholesale").trim(),
    storewidePercentOff: Number(formData.get("storewidePercentOff") || 0),
    minimumSubtotal: Number(formData.get("minimumSubtotal") || 0),
    minCartQuantity: Number(formData.get("minCartQuantity") || 1),
    enforceMinCartQty: formData.get("enforceMinCartQty") === "on",
    lockWholesaleAccess: formData.get("lockWholesaleAccess") === "on",
  });

  return data({ ok: true });
}

export default function WholesaleSettingsPage() {
  const { config } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  return (
    <Page title="Wholesale settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          {actionData && "ok" in actionData && actionData.ok ? (
            <Banner tone="success">Wholesale settings saved.</Banner>
          ) : null}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Wholesale app settings</Text>
              <Form method="post">
                <BlockStack gap="300">
                  <TextField label="Approved wholesale tag" name="wholesaleTag" autoComplete="off" defaultValue={config.wholesaleTag} />
                  <TextField label="Pending application tag" name="pendingTag" autoComplete="off" defaultValue={config.pendingTag} />
                  <TextField label="VIP wholesale tag" name="vipTag" autoComplete="off" defaultValue={config.vipTag} />
                  <TextField label="Global fallback discount %" name="storewidePercentOff" type="number" autoComplete="off" defaultValue={String(config.storewidePercentOff)} />
                  <TextField label="Minimum wholesale subtotal" name="minimumSubtotal" type="number" autoComplete="off" defaultValue={String(config.minimumSubtotal)} />
                  <TextField label="Minimum total cart quantity" name="minCartQuantity" type="number" autoComplete="off" defaultValue={String(config.minCartQuantity || 1)} />
                  <label><input type="checkbox" name="enforceMinCartQty" defaultChecked={config.enforceMinCartQty} /> Enforce minimum total cart quantity</label>
                  <label><input type="checkbox" name="lockWholesaleAccess" defaultChecked={config.lockWholesaleAccess} /> Restrict future wholesale-only behavior to approved tag</label>
                  <Button submit variant="primary" loading={saving}>Save settings</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}