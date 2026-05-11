import { Page, Layout, Card, Text, Button, BlockStack } from "@shopify/polaris";
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  return null;
}

export default function PurchaseExportPlaceholder() {
  const navigate = useNavigate();

  return (
    <Page
      title="Purchase Export"
      subtitle="Export purchasing and PO data. This page is a placeholder so the purchasing workflow can deploy cleanly."
      primaryAction={{ content: "Open Purchase Requests", onAction: () => navigate("/app/erp/purchase-requests") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Purchase export coming next</Text>
              <Text as="p" tone="subdued">
                The Purchase Requests route referenced this export page, but the export page file was missing from the last patch. This placeholder fixes the build and keeps the app stable.
              </Text>
              <Text as="p">
                Next upgrade can turn this into CSV/PDF vendor purchase exports, reorder list exports, and PO printouts.
              </Text>
              <Button onClick={() => navigate("/app/erp/purchase-requests")}>Back to Purchase Requests</Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
