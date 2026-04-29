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
  Select,
  Checkbox,
} from "@shopify/polaris";

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  return null;
}

type CalcType = "per_item" | "per_sqin" | "per_roll" | "flat";

type LineItem = {
  id: string;
  name: string;
  type: CalcType;
  cost: string;
};

type SectionKey =
  | "baseProduct"
  | "material"
  | "print"
  | "labor"
  | "application"
  | "machine"
  | "setup"
  | "overhead";

type Section = {
  enabled: boolean;
  items: LineItem[];
};

type Template = {
  name: string;
  productType: string;
  quantity: string;
  sqin: string;
  targetMargin: string;
  manualSellPrice: string;
  wastePercent: string;
  sections: Record<SectionKey, Section>;
};

const STORAGE_KEY = "gso_wholesale_calculator_templates_v1";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function item(name: string, type: CalcType, cost: string): LineItem {
  return { id: uid(), name, type, cost };
}

function emptySection(enabled = false): Section {
  return { enabled, items: [] };
}

function defaultSections(): Record<SectionKey, Section> {
  return {
    baseProduct: {
      enabled: true,
      items: [item("Blank bag / jar / box", "per_item", "0.12")],
    },
    material: {
      enabled: true,
      items: [item("Material", "per_item", "0.18")],
    },
    print: {
      enabled: true,
      items: [item("Ink / print cost", "per_item", "0.08")],
    },
    labor: {
      enabled: true,
      items: [item("Production labor", "per_item", "0.06")],
    },
    application: emptySection(false),
    machine: {
      enabled: true,
      items: [item("Machine cost", "per_item", "0.04")],
    },
    setup: {
      enabled: true,
      items: [item("Setup fee", "flat", "25")],
    },
    overhead: {
      enabled: true,
      items: [item("Packaging / overhead", "per_item", "0.03")],
    },
  };
}

const presets: Record<string, Partial<Template>> = {
  "Label Only - In House": {
    quantity: "1000",
    sqin: "12",
    targetMargin: "40",
    manualSellPrice: "0",
    wastePercent: "10",
    sections: {
      baseProduct: emptySection(false),
      material: {
        enabled: true,
        items: [
          item("Label roll", "per_sqin", "0.003"),
          item("Laminate", "per_sqin", "0.001"),
        ],
      },
      print: {
        enabled: true,
        items: [item("Ink", "per_sqin", "0.002")],
      },
      labor: {
        enabled: true,
        items: [item("Print labor", "per_item", "0.04")],
      },
      application: emptySection(false),
      machine: {
        enabled: true,
        items: [item("Printer / cutter time", "per_item", "0.03")],
      },
      setup: {
        enabled: true,
        items: [item("File setup", "flat", "25")],
      },
      overhead: {
        enabled: true,
        items: [item("Shop overhead", "per_item", "0.02")],
      },
    },
  },

  "Label Applied to Bag/Jar": {
    quantity: "1000",
    sqin: "12",
    targetMargin: "40",
    manualSellPrice: "0",
    wastePercent: "8",
    sections: {
      baseProduct: {
        enabled: true,
        items: [item("Bag / jar cost", "per_item", "0.15")],
      },
      material: {
        enabled: true,
        items: [item("Label material", "per_item", "0.08")],
      },
      print: {
        enabled: true,
        items: [item("Label print cost", "per_item", "0.04")],
      },
      labor: {
        enabled: true,
        items: [item("Packing labor", "per_item", "0.03")],
      },
      application: {
        enabled: true,
        items: [item("Apply label", "per_item", "0.08")],
      },
      machine: emptySection(false),
      setup: {
        enabled: true,
        items: [item("Setup fee", "flat", "25")],
      },
      overhead: {
        enabled: true,
        items: [item("Overhead", "per_item", "0.03")],
      },
    },
  },

  "DTP Bags - Outsourced Print": {
    quantity: "1000",
    sqin: "1",
    targetMargin: "40",
    manualSellPrice: "0",
    wastePercent: "5",
    sections: {
      baseProduct: emptySection(false),
      material: emptySection(false),
      print: {
        enabled: true,
        items: [item("Outsourced printed bag", "per_item", "0.42")],
      },
      labor: {
        enabled: true,
        items: [item("Seal / production labor", "per_item", "0.08")],
      },
      application: emptySection(false),
      machine: {
        enabled: true,
        items: [item("Sealer / machine cost", "per_item", "0.03")],
      },
      setup: {
        enabled: true,
        items: [item("Order setup", "flat", "20")],
      },
      overhead: {
        enabled: true,
        items: [item("Packaging / overhead", "per_item", "0.04")],
      },
    },
  },

  "Sticker Bags": {
    quantity: "1000",
    sqin: "8",
    targetMargin: "40",
    manualSellPrice: "0",
    wastePercent: "8",
    sections: {
      baseProduct: {
        enabled: true,
        items: [item("Blank bag", "per_item", "0.10")],
      },
      material: {
        enabled: true,
        items: [item("Sticker", "per_item", "0.07")],
      },
      print: emptySection(false),
      labor: {
        enabled: true,
        items: [item("Packing labor", "per_item", "0.03")],
      },
      application: {
        enabled: true,
        items: [item("Apply sticker", "per_item", "0.06")],
      },
      machine: emptySection(false),
      setup: {
        enabled: true,
        items: [item("Setup", "flat", "15")],
      },
      overhead: {
        enabled: true,
        items: [item("Overhead", "per_item", "0.03")],
      },
    },
  },

  "Custom Quote": {
    quantity: "1000",
    sqin: "1",
    targetMargin: "40",
    manualSellPrice: "0",
    wastePercent: "10",
    sections: defaultSections(),
  },
};

function calculateLine(item: LineItem, qty: number, sqin: number) {
  const cost = Number(item.cost) || 0;

  if (item.type === "per_item") return cost * qty;
  if (item.type === "per_sqin") return cost * sqin * qty;
  if (item.type === "per_roll") return cost;
  if (item.type === "flat") return cost;

  return 0;
}

const typeOptions = [
  { label: "Per item", value: "per_item" },
  { label: "Per sq in", value: "per_sqin" },
  { label: "Per roll / batch", value: "per_roll" },
  { label: "Flat fee", value: "flat" },
];

const sectionLabels: Record<SectionKey, string> = {
  baseProduct: "Base Product / Blank Cost",
  material: "Material Cost",
  print: "Print Cost",
  labor: "Labor Cost",
  application: "Application / Assembly Cost",
  machine: "Machine / Production Cost",
  setup: "Setup / Fixed Fees",
  overhead: "Overhead / Packaging",
};

export default function WholesaleCalculator() {
  const navigate = useNavigate();

  const [productType, setProductType] = useState("Custom Quote");
  const [templateName, setTemplateName] = useState("");
  const [quantity, setQuantity] = useState("1000");
  const [sqin, setSqin] = useState("1");
  const [targetMargin, setTargetMargin] = useState("40");
  const [manualSellPrice, setManualSellPrice] = useState("0");
  const [wastePercent, setWastePercent] = useState("10");
  const [sections, setSections] = useState<Record<SectionKey, Section>>(defaultSections());
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) setTemplates(JSON.parse(raw));
  }, []);

  function applyPreset(name: string) {
    const preset = presets[name];
    if (!preset) return;

    setProductType(name);
    setQuantity(preset.quantity || "1000");
    setSqin(preset.sqin || "1");
    setTargetMargin(preset.targetMargin || "40");
    setManualSellPrice(preset.manualSellPrice || "0");
    setWastePercent(preset.wastePercent || "10");
    setSections((preset.sections as Record<SectionKey, Section>) || defaultSections());
  }

  function updateSection(key: SectionKey, next: Section) {
    setSections((prev) => ({ ...prev, [key]: next }));
  }

  function updateItem(key: SectionKey, id: string, field: keyof LineItem, value: string) {
    const nextItems = sections[key].items.map((row) =>
      row.id === id ? { ...row, [field]: value } : row
    );

    updateSection(key, { ...sections[key], items: nextItems });
  }

  function addItem(key: SectionKey) {
    updateSection(key, {
      ...sections[key],
      items: [...sections[key].items, item("New cost", "per_item", "0")],
    });
  }

  function deleteItem(key: SectionKey, id: string) {
    updateSection(key, {
      ...sections[key],
      items: sections[key].items.filter((row) => row.id !== id),
    });
  }

  function saveTemplate() {
    const name = templateName.trim() || productType || "Saved Template";

    const nextTemplate: Template = {
      name,
      productType,
      quantity,
      sqin,
      targetMargin,
      manualSellPrice,
      wastePercent,
      sections,
    };

    const next = [
      ...templates.filter((template) => template.name !== name),
      nextTemplate,
    ];

    setTemplates(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setTemplateName(name);
  }

  function loadTemplate(name: string) {
    const found = templates.find((template) => template.name === name);
    if (!found) return;

    setTemplateName(found.name);
    setProductType(found.productType);
    setQuantity(found.quantity);
    setSqin(found.sqin);
    setTargetMargin(found.targetMargin);
    setManualSellPrice(found.manualSellPrice);
    setWastePercent(found.wastePercent);
    setSections(found.sections);
  }

  function deleteTemplate(name: string) {
    const next = templates.filter((template) => template.name !== name);
    setTemplates(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (templateName === name) setTemplateName("");
  }

  const calc = useMemo(() => {
    const qty = Number(quantity) || 0;
    const area = Number(sqin) || 0;

    const sectionTotals = Object.entries(sections).reduce(
      (acc, [key, section]) => {
        const total = section.enabled
          ? section.items.reduce((sum, row) => sum + calculateLine(row, qty, area), 0)
          : 0;

        return { ...acc, [key]: total };
      },
      {} as Record<SectionKey, number>
    );

    const subtotal =
      sectionTotals.baseProduct +
      sectionTotals.material +
      sectionTotals.print +
      sectionTotals.labor +
      sectionTotals.application +
      sectionTotals.machine +
      sectionTotals.setup +
      sectionTotals.overhead;

    const waste = subtotal * ((Number(wastePercent) || 0) / 100);
    const trueTotalCost = subtotal + waste;
    const trueUnitCost = qty > 0 ? trueTotalCost / qty : 0;

    const marginDecimal = (Number(targetMargin) || 0) / 100;
    const recommendedPrice =
      marginDecimal < 1 ? trueUnitCost / (1 - marginDecimal) : 0;

    const sellPrice =
      Number(manualSellPrice) > 0 ? Number(manualSellPrice) : recommendedPrice;

    const revenue = sellPrice * qty;
    const profit = revenue - trueTotalCost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    return {
      qty,
      sectionTotals,
      subtotal,
      waste,
      trueTotalCost,
      trueUnitCost,
      recommendedPrice,
      sellPrice,
      revenue,
      profit,
      margin,
    };
  }, [quantity, sqin, targetMargin, manualSellPrice, wastePercent, sections]);

  let badgeTone: "success" | "warning" | "critical" = "success";
  let badgeText = "Great margin";

  if (calc.margin < 20) {
    badgeTone = "critical";
    badgeText = "Low margin";
  } else if (calc.margin < 35) {
    badgeTone = "warning";
    badgeText = "Watch margin";
  }

  const templateOptions = [
    { label: "Select saved template", value: "" },
    ...templates.map((template) => ({
      label: template.name,
      value: template.name,
    })),
  ];

  return (
    <Page
      title="Wholesale Cost Calculator"
      subtitle="Build accurate pricing for labels, DTP, sticker bags, jars, boxes, combos, and custom jobs."
      backAction={{
        content: "Dashboard",
        onAction: () => navigate("/app"),
      }}
      primaryAction={{
        content: "Pricing Rules",
        onAction: () => navigate("/app/wholesale/rules"),
      }}
      secondaryActions={[
        { content: "Customers", onAction: () => navigate("/app/wholesale/customers") },
        { content: "Settings", onAction: () => navigate("/app/wholesale") },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Quote Setup
                </Text>
                <Badge tone={badgeTone}>{badgeText}</Badge>
              </InlineStack>

              <Select
                label="Product type preset"
                options={Object.keys(presets).map((name) => ({
                  label: name,
                  value: name,
                }))}
                value={productType}
                onChange={applyPreset}
              />

              <InlineStack gap="300">
                <TextField label="Quantity" value={quantity} onChange={setQuantity} autoComplete="off" />
                <TextField label="Square inches per item" value={sqin} onChange={setSqin} autoComplete="off" />
                <TextField label="Target margin" value={targetMargin} onChange={setTargetMargin} suffix="%" autoComplete="off" />
                <TextField label="Manual sell price" value={manualSellPrice} onChange={setManualSellPrice} prefix="$" autoComplete="off" />
              </InlineStack>

              <TextField label="Waste / spoilage" value={wastePercent} onChange={setWastePercent} suffix="%" autoComplete="off" />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            {(Object.keys(sections) as SectionKey[]).map((sectionKey) => {
              const section = sections[sectionKey];

              return (
                <Card key={sectionKey}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Checkbox
                        label={sectionLabels[sectionKey]}
                        checked={section.enabled}
                        onChange={(checked) =>
                          updateSection(sectionKey, { ...section, enabled: checked })
                        }
                      />

                      <Button onClick={() => addItem(sectionKey)}>
                        Add Item
                      </Button>
                    </InlineStack>

                    {section.items.map((row) => (
                      <InlineStack key={row.id} gap="300" blockAlign="end">
                        <TextField
                          label="Name"
                          value={row.name}
                          onChange={(value) => updateItem(sectionKey, row.id, "name", value)}
                          autoComplete="off"
                        />

                        <Select
                          label="Type"
                          options={typeOptions}
                          value={row.type}
                          onChange={(value) => updateItem(sectionKey, row.id, "type", value)}
                        />

                        <TextField
                          label="Cost"
                          value={row.cost}
                          onChange={(value) => updateItem(sectionKey, row.id, "cost", value)}
                          prefix="$"
                          autoComplete="off"
                        />
                        
                        <Button variant="primary" onClick={() => navigate("quotes")}>
                          Quote Builder
</                       Button>

                        <Button tone="critical" onClick={() => deleteItem(sectionKey, row.id)}>
                          Delete
                        </Button>
                      </InlineStack>
                    ))}

                    <Text as="p" tone="subdued">
                      Section total: ${calc.sectionTotals[sectionKey].toFixed(2)}
                    </Text>
                  </BlockStack>
                </Card>
              );
            })}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Profit + Quote Summary
              </Text>

              <Divider />

              <Text as="p">True unit cost: ${calc.trueUnitCost.toFixed(2)}</Text>
              <Text as="p">Recommended price: ${calc.recommendedPrice.toFixed(2)}</Text>
              <Text as="p">Active sell price: ${calc.sellPrice.toFixed(2)}</Text>
              <Text as="p">Margin: {calc.margin.toFixed(1)}%</Text>

              <Divider />

              <Text as="p">Total cost: ${calc.trueTotalCost.toFixed(2)}</Text>
              <Text as="p">Revenue: ${calc.revenue.toFixed(2)}</Text>
              <Text as="p">Profit: ${calc.profit.toFixed(2)}</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Templates
              </Text>

              <TextField
                label="Template name"
                value={templateName}
                onChange={setTemplateName}
                autoComplete="off"
              />

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveTemplate}>
                  Save Template
                </Button>

                <Select
                  label="Load template"
                  options={templateOptions}
                  value=""
                  onChange={loadTemplate}
                />

                {templateName ? (
                  <Button tone="critical" onClick={() => deleteTemplate(templateName)}>
                    Delete Template
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}