export const finishPresets: Record<
  string,
  {
    label: string;
    whiteLayers: number;
    glossLayers: number;
    sqftPerHour: number;
    preferredMachine: string;
  }
> = {
  base: {
    label: "Base CMYK",
    whiteLayers: 0,
    glossLayers: 0,
    sqftPerHour: 150,
    preferredMachine: "Mimaki or Roland",
  },
  white: {
    label: "White",
    whiteLayers: 1,
    glossLayers: 0,
    sqftPerHour: 70,
    preferredMachine: "Mimaki or Roland",
  },
  gloss: {
    label: "Gloss",
    whiteLayers: 0,
    glossLayers: 1,
    sqftPerHour: 60,
    preferredMachine: "Roland LG-540",
  },
  white_gloss: {
    label: "White + Gloss",
    whiteLayers: 1,
    glossLayers: 1,
    sqftPerHour: 45,
    preferredMachine: "Roland LG-540",
  },
  emboss: {
    label: "Emboss",
    whiteLayers: 0,
    glossLayers: 2,
    sqftPerHour: 35,
    preferredMachine: "Roland LG-540",
  },
  white_emboss: {
    label: "White + Emboss",
    whiteLayers: 1,
    glossLayers: 2,
    sqftPerHour: 30,
    preferredMachine: "Roland LG-540",
  },
  emboss_3x: {
    label: "3x Emboss",
    whiteLayers: 0,
    glossLayers: 3,
    sqftPerHour: 25,
    preferredMachine: "Roland LG-540",
  },
  white_emboss_3x: {
    label: "White + 3x Emboss",
    whiteLayers: 1,
    glossLayers: 3,
    sqftPerHour: 20,
    preferredMachine: "Roland LG-540",
  },
};

export const finishOptions = Object.entries(finishPresets).map(([value, preset]) => ({
  label: preset.label,
  value,
}));
