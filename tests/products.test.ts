import { describe, expect, it } from "vitest";
import {
  IMAGE_PROMPT_PREFIX,
  IMAGE_PROMPT_SUFFIX,
  PRODUCT_CATEGORIES,
  products,
  slugifyProductName,
} from "../src/lib/products";

const expectedProducts = [
  {
    id: "P01",
    name: "Orbit Wireless Headphones",
    category: "Audio",
    priceUsd: 89,
    stock: 12,
    slug: "orbit-wireless-headphones",
  },
  {
    id: "P02",
    name: "Nova Mechanical Keyboard",
    category: "Computing",
    priceUsd: 109,
    stock: 7,
    slug: "nova-mechanical-keyboard",
  },
  {
    id: "P03",
    name: "Luna Desk Lamp",
    category: "Home",
    priceUsd: 49,
    stock: 14,
    slug: "luna-desk-lamp",
  },
  {
    id: "P04",
    name: "Atlas Travel Backpack",
    category: "Accessories",
    priceUsd: 79,
    stock: 0,
    slug: "atlas-travel-backpack",
  },
  {
    id: "P05",
    name: "Echo Mini Speaker",
    category: "Audio",
    priceUsd: 59,
    stock: 9,
    slug: "echo-mini-speaker",
  },
  {
    id: "P06",
    name: "Pixel Wireless Mouse",
    category: "Computing",
    priceUsd: 35,
    stock: 21,
    slug: "pixel-wireless-mouse",
  },
  {
    id: "P07",
    name: "Halo Ceramic Mug",
    category: "Home",
    priceUsd: 24,
    stock: 18,
    slug: "halo-ceramic-mug",
  },
  {
    id: "P08",
    name: "Trek Stainless Bottle",
    category: "Accessories",
    priceUsd: 29,
    stock: 5,
    slug: "trek-stainless-bottle",
  },
  {
    id: "P09",
    name: "Pulse Sport Earbuds",
    category: "Audio",
    priceUsd: 69,
    stock: 0,
    slug: "pulse-sport-earbuds",
  },
  {
    id: "P10",
    name: "View USB-C Hub",
    category: "Computing",
    priceUsd: 45,
    stock: 17,
    slug: "view-usb-c-hub",
  },
  {
    id: "P11",
    name: "Arc Wall Clock",
    category: "Home",
    priceUsd: 39,
    stock: 8,
    slug: "arc-wall-clock",
  },
  {
    id: "P12",
    name: "Metro Laptop Sleeve",
    category: "Accessories",
    priceUsd: 34,
    stock: 10,
    slug: "metro-laptop-sleeve",
  },
  {
    id: "P13",
    name: "Studio Over-Ear Headphones",
    category: "Audio",
    priceUsd: 129,
    stock: 4,
    slug: "studio-over-ear-headphones",
  },
  {
    id: "P14",
    name: "Slate Portable SSD",
    category: "Computing",
    priceUsd: 119,
    stock: 6,
    slug: "slate-portable-ssd",
  },
  {
    id: "P15",
    name: "Glow Aroma Diffuser",
    category: "Home",
    priceUsd: 54,
    stock: 0,
    slug: "glow-aroma-diffuser",
  },
  {
    id: "P16",
    name: "Ridge Organizer Pouch",
    category: "Accessories",
    priceUsd: 19,
    stock: 13,
    slug: "ridge-organizer-pouch",
  },
  {
    id: "P17",
    name: "Wave Soundbar",
    category: "Audio",
    priceUsd: 179,
    stock: 3,
    slug: "wave-soundbar",
  },
  {
    id: "P18",
    name: "Aero Laptop Stand",
    category: "Computing",
    priceUsd: 64,
    stock: 0,
    slug: "aero-laptop-stand",
  },
  {
    id: "P19",
    name: "Pebble Plant Pot",
    category: "Home",
    priceUsd: 22,
    stock: 15,
    slug: "pebble-plant-pot",
  },
  {
    id: "P20",
    name: "Terra Canvas Tote",
    category: "Accessories",
    priceUsd: 25,
    stock: 12,
    slug: "terra-canvas-tote",
  },
  {
    id: "P21",
    name: "Mini Bluetooth Radio",
    category: "Audio",
    priceUsd: 44,
    stock: 7,
    slug: "mini-bluetooth-radio",
  },
  {
    id: "P22",
    name: "Clarity Webcam",
    category: "Computing",
    priceUsd: 84,
    stock: 11,
    slug: "clarity-webcam",
  },
  {
    id: "P23",
    name: "Cozy Throw Blanket",
    category: "Home",
    priceUsd: 74,
    stock: 2,
    slug: "cozy-throw-blanket",
  },
  {
    id: "P24",
    name: "Summit Carry-On Case",
    category: "Accessories",
    priceUsd: 149,
    stock: 5,
    slug: "summit-carry-on-case",
  },
] as const;

describe("product fixture", () => {
  it("matches the exact 24-product fixture", () => {
    expect(products).toHaveLength(24);
    expect(
      products.map(({ id, name, category, priceUsd, stock, slug }) => ({
        id,
        name,
        category,
        priceUsd,
        stock,
        slug,
      })),
    ).toEqual(expectedProducts);
  });

  it("has unique IDs, names, and slugs", () => {
    expect(new Set(products.map((product) => product.id)).size).toBe(products.length);
    expect(new Set(products.map((product) => product.name)).size).toBe(products.length);
    expect(new Set(products.map((product) => product.slug)).size).toBe(products.length);
  });

  it("has four equal-size categories", () => {
    expect(PRODUCT_CATEGORIES).toEqual(["Audio", "Computing", "Home", "Accessories"]);
    for (const category of PRODUCT_CATEGORIES) {
      expect(products.filter((product) => product.category === category)).toHaveLength(6);
    }
    expect(new Set(products.map((product) => product.category))).toEqual(
      new Set(PRODUCT_CATEGORIES),
    );
  });

  it("derives every slug from its name with the documented rule", () => {
    for (const product of products) {
      expect(product.slug).toBe(slugifyProductName(product.name));
      expect(product.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("preserves the released P19 slug", () => {
    expect(products.find((product) => product.id === "P19")).toMatchObject({
      name: "Pebble Plant Pot",
      slug: "pebble-plant-pot",
      priceUsd: 22,
      stock: 15,
    });
  });

  it("uses USD integer prices and integer nonnegative stock", () => {
    for (const product of products) {
      expect(product.currency).toBe("USD");
      expect(Number.isInteger(product.priceUsd)).toBe(true);
      expect(product.priceUsd).toBeGreaterThan(0);
      expect(Number.isInteger(product.stock)).toBe(true);
      expect(product.stock).toBeGreaterThanOrEqual(0);
    }
  });

  it("has distinct, meaningful descriptions", () => {
    const descriptions = products.map((product) => product.description);
    expect(new Set(descriptions).size).toBe(products.length);
    for (const description of descriptions) {
      expect(description.trim()).toBe(description);
      expect(description.length).toBeGreaterThanOrEqual(40);
      expect(description.length).toBeLessThanOrEqual(160);
    }
  });

  it("uses the exact shared image prompt template", () => {
    expect(IMAGE_PROMPT_PREFIX).toBe("Professional e-commerce photograph of");
    expect(IMAGE_PROMPT_SUFFIX).toBe(
      "Single centered product, neutral light-gray studio background, soft diffused lighting, realistic materials and textures, sharp focus, no people, no text, no logos, square composition.",
    );
  });

  it("has distinct product-specific image prompts using the shared template", () => {
    const prefix = `${IMAGE_PROMPT_PREFIX} `;
    const suffix = `. ${IMAGE_PROMPT_SUFFIX}`;
    const prompts = products.map((product) => product.imagePrompt);
    expect(new Set(prompts).size).toBe(products.length);
    for (const prompt of prompts) {
      expect(prompt.startsWith(prefix)).toBe(true);
      expect(prompt.endsWith(suffix)).toBe(true);
      const subject = prompt.slice(prefix.length, prompt.length - suffix.length);
      expect(subject.length).toBeGreaterThan(30);
    }
  });
});
