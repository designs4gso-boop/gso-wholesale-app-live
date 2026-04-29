import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { useNavigate } from "react-router";

export default function Index() {
  const navigate = useNavigate();

  return (
    <Page
      title="GSO Wholesale Command Center"
      subtitle="Manage wholesale pricing, customers, calculators, rules, and applications."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      Wholesale Lite
                    </Text>
                    <Text as="p" tone="subdued">
                      Shopify embedded app auth is working.
                    </Text>
                  </BlockStack>

                  <Badge tone="success">Live</Badge>
                </InlineStack>

                <InlineStack gap="300">
                  <Button variant="primary" onClick={() => navigate("wholesale/calculator")}>
                    Cost Calculator
                  </Button>

                  <Button onClick={() => navigate("wholesale/rules")}>
                    Pricing Rules
                  </Button>

                  <Button onClick={() => navigate("wholesale/customers")}>
                    Wholesale Customers
                  </Button>

                  <Button onClick={() => navigate("wholesale")}>
                    Wholesale Settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Wholesale Engine Status
                </Text>
                <Text as="p">Customer tag pricing enabled</Text>
                <Text as="p">Tier pricing enabled</Text>
                <Text as="p">Cost calculator database ready</Text>
                <Text as="p">Shopify discount function deployed</Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Quick Actions
                </Text>

                <Button fullWidth onClick={() => navigate("wholesale/calculator")}>
                  Build Quote
                </Button>

                <Button fullWidth onClick={() => navigate("wholesale/rules")}>
                  Create Pricing Tier
                </Button>

                <Button fullWidth onClick={() => navigate("create-wholesale-discount")}>
                  Create Shopify Discount
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}