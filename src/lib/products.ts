export const PRODUCT_CATEGORIES = ["Audio", "Computing", "Home", "Accessories"] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface Product {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly category: ProductCategory;
  readonly priceUsd: number;
  readonly currency: "USD";
  readonly stock: number;
  readonly description: string;
  readonly imagePrompt: string;
}

export const IMAGE_PROMPT_PREFIX = "Professional e-commerce photograph of";

export const IMAGE_PROMPT_SUFFIX =
  "Single centered product, neutral light-gray studio background, soft diffused lighting, realistic materials and textures, sharp focus, no people, no text, no logos, square composition.";

function buildImagePrompt(subject: string): string {
  return `${IMAGE_PROMPT_PREFIX} ${subject}. ${IMAGE_PROMPT_SUFFIX}`;
}

export function slugifyProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const products = [
  {
    id: "P01",
    slug: "orbit-wireless-headphones",
    name: "Orbit Wireless Headphones",
    category: "Audio",
    priceUsd: 89,
    currency: "USD",
    stock: 12,
    description:
      "Over-ear wireless headphones with active noise cancellation and a 30-hour battery.",
    imagePrompt: buildImagePrompt(
      "matte charcoal over-ear wireless headphones with plush memory-foam ear cushions and a slim silver headband",
    ),
  },
  {
    id: "P02",
    slug: "nova-mechanical-keyboard",
    name: "Nova Mechanical Keyboard",
    category: "Computing",
    priceUsd: 109,
    currency: "USD",
    stock: 7,
    description:
      "Tenkeyless mechanical keyboard with tactile switches and a warm white backlight.",
    imagePrompt: buildImagePrompt(
      "compact tenkeyless mechanical keyboard with dark graphite keycaps, warm white backlighting, and a brushed aluminum frame",
    ),
  },
  {
    id: "P03",
    slug: "luna-desk-lamp",
    name: "Luna Desk Lamp",
    category: "Home",
    priceUsd: 49,
    currency: "USD",
    stock: 14,
    description:
      "Adjustable LED desk lamp with three brightness levels and a warm-to-cool light range.",
    imagePrompt: buildImagePrompt(
      "minimalist desk lamp with a matte sage-green conical shade, warm LED glow, and a rounded walnut base",
    ),
  },
  {
    id: "P04",
    slug: "atlas-travel-backpack",
    name: "Atlas Travel Backpack",
    category: "Accessories",
    priceUsd: 79,
    currency: "USD",
    stock: 0,
    description:
      "Weather-resistant 28-liter travel backpack with a padded laptop sleeve.",
    imagePrompt: buildImagePrompt(
      "olive-green waxed-canvas travel backpack with tan leather straps, brass buckles, and a rounded top flap",
    ),
  },
  {
    id: "P05",
    slug: "echo-mini-speaker",
    name: "Echo Mini Speaker",
    category: "Audio",
    priceUsd: 59,
    currency: "USD",
    stock: 9,
    description:
      "Pocket-sized Bluetooth speaker with a warm sound profile and an eight-hour battery.",
    imagePrompt: buildImagePrompt(
      "palm-sized fabric-wrapped mini speaker in dusty blue with a woven gray grille and a small rubber base",
    ),
  },
  {
    id: "P06",
    slug: "pixel-wireless-mouse",
    name: "Pixel Wireless Mouse",
    category: "Computing",
    priceUsd: 35,
    currency: "USD",
    stock: 21,
    description:
      "Ergonomic wireless mouse with silent clicks and adjustable sensitivity.",
    imagePrompt: buildImagePrompt(
      "low-profile wireless mouse in soft off-white with a subtle rose accent wheel and a smooth matte shell",
    ),
  },
  {
    id: "P07",
    slug: "halo-ceramic-mug",
    name: "Halo Ceramic Mug",
    category: "Home",
    priceUsd: 24,
    currency: "USD",
    stock: 18,
    description:
      "Hand-glazed ceramic mug that holds 12 ounces of coffee or tea.",
    imagePrompt: buildImagePrompt(
      "speckled cream ceramic mug with a wide rounded handle and a hand-glazed terracotta rim",
    ),
  },
  {
    id: "P08",
    slug: "trek-stainless-bottle",
    name: "Trek Stainless Bottle",
    category: "Accessories",
    priceUsd: 29,
    currency: "USD",
    stock: 5,
    description:
      "Insulated stainless-steel bottle that keeps drinks cold for 24 hours.",
    imagePrompt: buildImagePrompt(
      "brushed stainless-steel water bottle in deep teal with a black screw cap and a slim silicone carry loop",
    ),
  },
  {
    id: "P09",
    slug: "pulse-sport-earbuds",
    name: "Pulse Sport Earbuds",
    category: "Audio",
    priceUsd: 69,
    currency: "USD",
    stock: 0,
    description:
      "Sweat-resistant sport earbuds with secure ear fins and a compact charging case.",
    imagePrompt: buildImagePrompt(
      "compact sport earbuds in coral orange with flexible ear fins, short stems, and a matching charging case",
    ),
  },
  {
    id: "P10",
    slug: "view-usb-c-hub",
    name: "View USB-C Hub",
    category: "Computing",
    priceUsd: 45,
    currency: "USD",
    stock: 17,
    description:
      "Seven-port USB-C hub with HDMI, SD card, and fast charging support.",
    imagePrompt: buildImagePrompt(
      "slim silver USB-C hub with a braided graphite cable and a neat row of connectivity ports",
    ),
  },
  {
    id: "P11",
    slug: "arc-wall-clock",
    name: "Arc Wall Clock",
    category: "Home",
    priceUsd: 39,
    currency: "USD",
    stock: 8,
    description:
      "Silent quartz wall clock with a pale oak frame and an easy-to-read face.",
    imagePrompt: buildImagePrompt(
      "round wall clock with a pale oak frame, a clean white face, and slim black hands",
    ),
  },
  {
    id: "P12",
    slug: "metro-laptop-sleeve",
    name: "Metro Laptop Sleeve",
    category: "Accessories",
    priceUsd: 34,
    currency: "USD",
    stock: 10,
    description:
      "Felt laptop sleeve with a padded lining and a front accessory pocket.",
    imagePrompt: buildImagePrompt(
      "padded laptop sleeve in charcoal felt with a tan leather zipper pull and a stitched front pocket",
    ),
  },
  {
    id: "P13",
    slug: "studio-over-ear-headphones",
    name: "Studio Over-Ear Headphones",
    category: "Audio",
    priceUsd: 129,
    currency: "USD",
    stock: 4,
    description:
      "Wired studio headphones with detailed sound and replaceable velour pads.",
    imagePrompt: buildImagePrompt(
      "studio over-ear headphones in midnight blue with replaceable velour ear pads and a coiled black cable",
    ),
  },
  {
    id: "P14",
    slug: "slate-portable-ssd",
    name: "Slate Portable SSD",
    category: "Computing",
    priceUsd: 119,
    currency: "USD",
    stock: 6,
    description:
      "Portable solid-state drive with 1 TB capacity and USB-C connectivity.",
    imagePrompt: buildImagePrompt(
      "pocket-sized portable SSD in slate gray aluminum with chamfered edges and a short USB-C cable",
    ),
  },
  {
    id: "P15",
    slug: "glow-aroma-diffuser",
    name: "Glow Aroma Diffuser",
    category: "Home",
    priceUsd: 54,
    currency: "USD",
    stock: 0,
    description:
      "Ultrasonic aroma diffuser with a warm light and a four-hour run time.",
    imagePrompt: buildImagePrompt(
      "rounded ceramic aroma diffuser in warm sand with a small wooden base and a soft mist opening",
    ),
  },
  {
    id: "P16",
    slug: "ridge-organizer-pouch",
    name: "Ridge Organizer Pouch",
    category: "Accessories",
    priceUsd: 19,
    currency: "USD",
    stock: 13,
    description:
      "Small ripstop pouch for cables, adapters, and everyday carry items.",
    imagePrompt: buildImagePrompt(
      "compact organizer pouch in rust-colored ripstop nylon with a black zipper and a triangular leather tab",
    ),
  },
  {
    id: "P17",
    slug: "wave-soundbar",
    name: "Wave Soundbar",
    category: "Audio",
    priceUsd: 179,
    currency: "USD",
    stock: 3,
    description:
      "Two-channel soundbar with clear dialogue and a compact fabric-wrapped body.",
    imagePrompt: buildImagePrompt(
      "wide soundbar in matte black fabric with a slim profile, rounded ends, and a subtle metal control strip",
    ),
  },
  {
    id: "P18",
    slug: "aero-laptop-stand",
    name: "Aero Laptop Stand",
    category: "Computing",
    priceUsd: 64,
    currency: "USD",
    stock: 0,
    description:
      "Foldable aluminum stand that raises a laptop to a comfortable viewing angle.",
    imagePrompt: buildImagePrompt(
      "foldable laptop stand in anodized silver aluminum with angled arms and small rubber grips",
    ),
  },
  {
    id: "P19",
    slug: "pebble-plant-pot",
    name: "Pebble Plant Pot",
    category: "Home",
    priceUsd: 22,
    currency: "USD",
    stock: 15,
    description:
      "Stoneware planter with a drainage hole and matching saucer for small plants.",
    imagePrompt: buildImagePrompt(
      "small pebble-shaped plant pot in speckled stoneware with a soft gray glaze and a drainage saucer",
    ),
  },
  {
    id: "P20",
    slug: "terra-canvas-tote",
    name: "Terra Canvas Tote",
    category: "Accessories",
    priceUsd: 25,
    currency: "USD",
    stock: 12,
    description:
      "Roomy canvas tote with reinforced handles and an interior pocket.",
    imagePrompt: buildImagePrompt(
      "structured canvas tote in natural ecru with dark navy handles and an interior pocket",
    ),
  },
  {
    id: "P21",
    slug: "mini-bluetooth-radio",
    name: "Mini Bluetooth Radio",
    category: "Audio",
    priceUsd: 44,
    currency: "USD",
    stock: 7,
    description:
      "Compact analog radio with FM/AM tuning and a built-in speaker.",
    imagePrompt: buildImagePrompt(
      "retro mini radio in butter yellow with a silver speaker grille, a small analog dial, and a telescopic antenna",
    ),
  },
  {
    id: "P22",
    slug: "clarity-webcam",
    name: "Clarity Webcam",
    category: "Computing",
    priceUsd: 84,
    currency: "USD",
    stock: 11,
    description:
      "1080p webcam with a wide-angle lens and a built-in microphone.",
    imagePrompt: buildImagePrompt(
      "compact webcam in graphite gray with a wide black lens ring and a flexible clip mount",
    ),
  },
  {
    id: "P23",
    slug: "cozy-throw-blanket",
    name: "Cozy Throw Blanket",
    category: "Home",
    priceUsd: 74,
    currency: "USD",
    stock: 2,
    description:
      "Soft ribbed throw blanket that adds warmth to a sofa or bed.",
    imagePrompt: buildImagePrompt(
      "chunky throw blanket in oatmeal beige with a soft ribbed weave and fringed edges",
    ),
  },
  {
    id: "P24",
    slug: "summit-carry-on-case",
    name: "Summit Carry-On Case",
    category: "Accessories",
    priceUsd: 149,
    currency: "USD",
    stock: 5,
    description:
      "Lightweight hard-shell carry-on with spinner wheels and a TSA-friendly layout.",
    imagePrompt: buildImagePrompt(
      "hard-shell carry-on case in forest green with a matte finish, four spinner wheels, and a slim silver handle",
    ),
  },
] as const satisfies readonly Product[];

export type ProductId = (typeof products)[number]["id"];
export type ProductSlug = (typeof products)[number]["slug"];

export function findProductBySlug(slug: string): Product | undefined {
  return products.find((product) => product.slug === slug);
}
