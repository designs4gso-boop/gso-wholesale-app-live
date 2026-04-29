import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
} from "@shopify/polaris";

import { useState } from "react";
import { useNavigate } from "react-router";


export default function WholesaleCalculator() {
  const navigate = useNavigate();

  const [materialCost, setMaterialCost] = useState("0.18");
  const [printCost, setPrintCost] = useState("0.08");
  const [laborCost, setLaborCost] = useState("0.06");
  const [machineCost, setMachineCost] = useState("0.04");
  const [packagingCost, setPackagingCost] = useState("0.03");
  const [wastePercent, setWastePercent] = useState("10");
  const [setupFee, setSetupFee] = useState("25");
  const [artworkFee, setArtworkFee] = useState("0");
  const [rushFee, setRushFee] = useState("0");
  const [sellPrice, setSellPrice] = useState("0.65");
  const [qty, setQty] = useState("64");

  const material = Number(materialCost) || 0;
  const print = Number(printCost) || 0;
  const labor = Number(laborCost) || 0;
  const machine = Number(machineCost) || 0;
  const packaging = Number(packagingCost) || 0;
  const waste = Number(wastePercent) || 0;
  const setup = Number(setupFee) || 0;
  const artwork = Number(artworkFee) || 0;
  const rush = Number(rushFee) || 0;
  const price = Number(sellPrice) || 0;
  const quantity = Number(qty) || 0;

  const baseUnitCost = material + print + labor + machine + packaging;
  const wasteCost = baseUnitCost * (waste / 100);
  const totalUnitCost = baseUnitCost + wasteCost;

  const totalFees = setup + artwork + rush;
  const feePerUnit = quantity > 0 ? totalFees / quantity : 0;
  const trueUnitCost = totalUnitCost + feePerUnit;

  const profitEach = price - trueUnitCost;
  const marginPercent = price > 0 ? (profitEach / price) * 100 : 0;
  const markupPercent = trueUnitCost > 0 ? (profitEach / trueUnitCost) * 100 : 0;

  const totalRevenue = price * quantity;
  const totalCost = trueUnitCost * quantity;
  const totalProfit = profitEach * quantity;

  let healthTone: "success" | "warning" | "critical" = "success";
  let healthText = "Healthy margin";

  if (marginPercent < 20) {
    healthTone = "critical";
    healthText = "Danger: low margin";
  } else if (marginPercent < 35) {
    healthTone = "warning";
    healthText = "Watch margin";
  }

  function applyTier(price: string, amount: string) {
    setSellPrice(price);
    setQty(amount);
  }

  return (
    <Page
      title="Wholesale Cost Calculator"
      subtitle="Calculate print costs, minimum quantities, wholesale price, profit, and margins."
      backAction={{
        content: "Dashboard",
        onAction: () => navigate("/app"),
      }}
      primaryAction={{
        content: "Pricing Rules",
        onAction: () => navigate("/app/wholesale/rules"),
      }}
      secondaryActions={[
        {
          content: "Customers",
          onAction: () => navigate("/app/wholesale/customers"),
        },
        {
          content: "Settings",
          onAction: () => navigate("/app/wholesale"),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Quick Wholesale Tiers
                </Text>
                <Badge tone={healthTone}>{healthText}</Badge>
              </InlineStack>

              <InlineStack gap="300">
                <Button onClick={() => applyTier("0.65", "64")}>
                  64+ @ $0.65
                </Button>
                <Button onClick={() => applyTier("0.60", "100")}>
                  100+ @ $0.60
                </Button>
                <Button onClick={() => applyTier("0.55", "500")}>
                  500+ @ $0.55
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Production Costs Per Unit
              </Text>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Material" value={materialCost} onChange={setMaterialCost} prefix="$" autoComplete="off" />
                <TextField label="Print" value={printCost} onChange={setPrintCost} prefix="$" autoComplete="off" />
                <TextField label="Labor" value={laborCost} onChange={setLaborCost} prefix="$" autoComplete="off" />
              </InlineStack>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Machine" value={machineCost} onChange={setMachineCost} prefix="$" autoComplete="off" />
                <TextField label="Packaging" value={packagingCost} onChange={setPackagingCost} prefix="$" autoComplete="off" />
                <TextField label="Waste" value={wastePercent} onChange={setWastePercent} suffix="%" autoComplete="off" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Order Fees
              </Text>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Setup fee" value={setupFee} onChange={setSetupFee} prefix="$" autoComplete="off" />
                <TextField label="Artwork fee" value={artworkFee} onChange={setArtworkFee} prefix="$" autoComplete="off" />
                <TextField label="Rush fee" value={rushFee} onChange={setRushFee} prefix="$" autoComplete="off" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Wholesale Price Setup
              </Text>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Minimum quantity" value={qty} onChange={setQty} autoComplete="off" />
                <TextField label="Wholesale sell price" value={sellPrice} onChange={setSellPrice} prefix="$" autoComplete="off" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Profit Snapshot
              </Text>

              <Divider />

              <Text as="p">Base unit cost: ${baseUnitCost.toFixed(2)}</Text>
              <Text as="p">Waste per unit: ${wasteCost.toFixed(2)}</Text>
              <Text as="p">Fee per unit: ${feePerUnit.toFixed(2)}</Text>
              <Text as="p">True unit cost: ${trueUnitCost.toFixed(2)}</Text>

              <Divider />

              <Text as="p">Profit per unit: ${profitEach.toFixed(2)}</Text>
              <Text as="p">Margin: {marginPercent.toFixed(1)}%</Text>
              <Text as="p">Markup: {markupPercent.toFixed(1)}%</Text>

              <Divider />

              <Text as="p">Revenue: ${totalRevenue.toFixed(2)}</Text>
              <Text as="p">Cost: ${totalCost.toFixed(2)}</Text>
              <Text as="p">Profit: ${totalProfit.toFixed(2)}</Text>

              <Button variant="primary" fullWidth>
                Save Calculator Preset
              </Button>

              <Button fullWidth onClick={() => navigate("/app/wholesale/rules")}>
                Turn Into Pricing Rule
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}