// Itemi tržišta resursa (transactionType "trading"), redoslijed kao u dizajnu stranice.
// tier = boja pozadine ikonice u igri: gray, green, blue, purple, red, olive
export const ITEMS = [
  { code: "limestone", name: "Limestone", tier: "gray" },
  { code: "grain", name: "Grain", tier: "gray" },
  { code: "livestock", name: "Livestock", tier: "gray" },
  { code: "fish", name: "Fish", tier: "gray" },
  { code: "iron", name: "Iron", tier: "gray" },
  { code: "coca", name: "Coca leaf", tier: "gray" },
  { code: "lead", name: "Lead", tier: "gray" },
  { code: "petroleum", name: "Petroleum", tier: "gray" },
  { code: "wood", name: "Wood", tier: "gray" },
  { code: "concrete", name: "Concrete", tier: "green" },
  { code: "steel", name: "Steel", tier: "green" },
  { code: "bread", name: "Bread", tier: "green" },
  { code: "lightAmmo", name: "Light ammo", tier: "green" },
  { code: "oil", name: "Oil", tier: "green" },
  { code: "paper", name: "Paper", tier: "green" },
  { code: "steak", name: "Steak", tier: "blue" },
  { code: "ammo", name: "Ammo", tier: "blue" },
  { code: "scraps", name: "Scraps", tier: "blue" },
  { code: "cookedFish", name: "Cooked fish", tier: "purple" },
  { code: "cocain", name: "Cocaine", tier: "purple" },
  { code: "heavyAmmo", name: "Heavy ammo", tier: "purple" },
  { code: "case1", name: "Case", tier: "olive" },
  { code: "case2", name: "Elite case", tier: "red" },
];

export const ITEM_CODES = new Set(ITEMS.map((i) => i.code));
