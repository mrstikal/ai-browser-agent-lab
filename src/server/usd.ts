export const MAX_USD_DECIMALS = 6;
export const USD_MICRO_SCALE = 1_000_000n;

export class UsdFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UsdFormatError";
  }
}

const USD_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/**
 * Parses a non-negative decimal USD string into integer micro-USD without
 * floating point, so sub-cent prices (for example 0.008) stay exact.
 */
export function parseUsdToMicro(value: string): bigint {
  if (typeof value !== "string") {
    throw new UsdFormatError("USD amounts must be strings.");
  }
  const match = USD_PATTERN.exec(value.trim());
  if (!match) {
    throw new UsdFormatError(
      "USD amounts must be non-negative decimals with at most six decimal places.",
    );
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(MAX_USD_DECIMALS, "0");
  return whole * USD_MICRO_SCALE + BigInt(fraction || "0");
}

export function formatUsdMicro(micro: bigint): string {
  if (micro < 0n) throw new UsdFormatError("USD amounts cannot be negative.");
  const whole = micro / USD_MICRO_SCALE;
  const fraction = (micro % USD_MICRO_SCALE).toString().padStart(MAX_USD_DECIMALS, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

/**
 * Converts a JSON price number to an exact micro-USD decimal string, or
 * undefined when it cannot be represented without losing value.
 */
export function decimalStringFromNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const rounded = value.toFixed(MAX_USD_DECIMALS);
  if (Number(rounded) !== value) return undefined;
  return rounded.includes(".")
    ? rounded.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".00")
    : `${rounded}.00`;
}
