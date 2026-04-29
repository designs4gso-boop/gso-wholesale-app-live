import { Page, Layout, Card, TextField, Button, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { useState } from "react";

export default function WholesaleCalculator() {
  const [materialCost, setMaterialCost] = useState("0");
  const [printCost, setPrintCost] = useState("0");
  const [laborCost, setLaborCost] = useState("0");
  const [machineCost, setMachineCost] = useState("0");
  const [packagingCost, setPackagingCost] = useState("0");
  const [wastePercent, setWastePercent] = useState("10");
  const [sellPrice, setSellPrice] = useState("0.65");
  const [qty, setQty] = useState("64");

  const material = Number(materialCost) || 0;
  const print = Number(printCost) || 0;
  const labor = Number(laborCost) || 0;
  const machine = Number(machineCost) || 0;
  const packaging = Number(packagingCost) || 0;
  const waste = Number(wastePercent) || 0;
  const price = Number(sellPrice) || 0;
  const quantity = Number(qty) || 0;

  const baseUnitCost = material + print + labor + machine + packaging;
  const wasteCost = baseUnitCost * (waste / 100);
  const totalUnitCost = baseUnitCost + wasteCost;
  const profitEach = price - totalUnitCost;
  const marginPercent = price > 0 ? (profitEach / price) * 100 : 0;
  const totalRevenue = price * quantity;
  const totalCost = totalUnitCost * quantity;
  const totalProfit = profitEach * quantity;

  return (
    <Page
      title="Wholesale Cost Calculator"
      subtitle="Build profitable print-shop wholesale pricing with minimum quantities, tiers, cost, and margin checks."
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Production Costs Per Unit
              </Text>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Material cost" value={materialCost} onChange={setMaterialCost} autoComplete="off" prefix="$" />
                <TextField label="Print cost" value={printCost} onChange={setPrintCost} autoComplete="off" prefix="$" />
                <TextField label="Labor cost" value={laborCost} onChange={setLaborCost} autoComplete="off" prefix="$" />
              </InlineStack>

              <InlineStack gap="400" wrap={false}>
                <TextField label="Machine cost" value={machineCost} onChange={setMachineCost} autoComplete="off" prefix="$" />
                <TextField label="Packaging cost" value={packagingCost} onChange={setPackagingCost} autoComplete="off" prefix="$" />
                <TextField label="Waste %" value={wastePercent} onChange={setWastePercent} autoComplete="off" suffix="%" />
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
                <TextField label="Wholesale sell price" value={sellPrice} onChange={setSellPrice} autoComplete="off" prefix="$" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Profit Breakdown
              </Text>

              <Text as="p">Base unit cost: ${baseUnitCost.toFixed(2)}</Text>
              <Text as="p">Waste cost per unit: ${wasteCost.toFixed(2)}</Text>
              <Text as="p">Total unit cost: ${totalUnitCost.toFixed(2)}</Text>
              <Text as="p">Profit per unit: ${profitEach.toFixed(2)}</Text>
              <Text as="p">Margin: {marginPercent.toFixed(1)}%</Text>
              <Text as="p">Total revenue: ${totalRevenue.toFixed(2)}</Text>
              <Text as="p">Total cost: ${totalCost.toFixed(2)}</Text>
              <Text as="p">Total profit: ${totalProfit.toFixed(2)}</Text>

              <Button variant="primary">Save calculator preset</Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}