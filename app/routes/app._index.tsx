import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

import { Page, Card, Text, Button, BlockStack } from "@shopify/polaris";

export default function Index() {
  return (
    <Page title="GSO Wholesale Dashboard">
      <BlockStack gap="400">

        <Card>
          <Text as="p">
            Shopify embedded app auth is working.
          </Text>
        </Card>

        {/* 🔥 YOUR NEW BUTTON */}
        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd">
              Wholesale Tools
            </Text>

            <Button url="/app/wholesale/calculator">
              Open Cost Calculator
            </Button>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}

export default function AppIndex() {
  return (
    <s-page>
      <s-section heading="Wholesale Lite">
        <s-text>
          Shopify embedded app auth is working.
        </s-text>
      </s-section>
    </s-page>
  );
}