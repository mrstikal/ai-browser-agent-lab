import {
  normalizeTaskName,
  parseCatalogTaskAnswer,
  type CatalogAudioAnswer,
  type CatalogCheapestHomeAnswer,
  type CatalogOutOfStockAnswer,
  type CatalogTaskAnswer,
} from "../lib/agent-tasks";
import { formatUsd } from "../lib/format";
import { products, type Product } from "../lib/products";
import type { AgentRunEvaluation, AgentRunRecord } from "./agent-runs";

/**
 * Deterministic business evaluator for catalog Tasks 1-3. Expectations come
 * from the fixed product fixture; the agent never receives them. This module
 * has no supervisor/storage imports so restart recovery can evaluate terminal
 * preset runs without creating an import cycle.
 */

export interface CatalogTaskExpectations {
  readonly cheapestHome: Product;
  readonly outOfStock: readonly Product[];
  readonly audioUnder70: readonly Product[];
}

function byPriceThenId(left: Product, right: Product): number {
  return left.priceUsd - right.priceUsd || left.id.localeCompare(right.id);
}

export function catalogTaskExpectations(): CatalogTaskExpectations {
  const cheapestHome = products
    .filter((product) => product.category === "Home" && product.stock > 0)
    .sort(byPriceThenId)[0];
  if (!cheapestHome) {
    throw new Error("The catalog fixture has no available Home product.");
  }
  const outOfStock = products
    .filter((product) => product.stock === 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const audioUnder70 = products
    .filter(
      (product) =>
        product.category === "Audio" &&
        product.stock > 0 &&
        product.priceUsd < 70,
    )
    .sort(byPriceThenId);
  return { cheapestHome, outOfStock, audioUnder70 };
}

interface Comparison {
  readonly passed: boolean;
  readonly reason: string;
}

function pass(reason: string): Comparison {
  return { passed: true, reason };
}

function fail(reason: string): Comparison {
  return { passed: false, reason };
}

function compareCheapestHome(
  answer: CatalogCheapestHomeAnswer,
  origin: string,
): Comparison {
  const expected = catalogTaskExpectations().cheapestHome;
  if (normalizeTaskName(answer.name) !== normalizeTaskName(expected.name)) {
    return fail(`Expected "${expected.name}" but received "${answer.name}".`);
  }
  if (answer.priceUsd !== expected.priceUsd) {
    return fail(
      `Expected ${formatUsd(expected.priceUsd)} but received ${formatUsd(answer.priceUsd)}.`,
    );
  }
  let configuredOrigin: URL;
  let resolved: URL;
  try {
    configuredOrigin = new URL(origin);
    resolved = new URL(answer.url, origin);
  } catch {
    return fail("The answer URL could not be resolved against the app origin.");
  }
  if (resolved.origin !== configuredOrigin.origin) {
    return fail(
      `The answer URL must use the configured origin ${configuredOrigin.origin}.`,
    );
  }
  const expectedPath = `/shop/products/${expected.slug}`;
  const normalizedPath = resolved.pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath !== expectedPath) {
    return fail(
      `Expected the product page path ${expectedPath} but received ${normalizedPath}.`,
    );
  }
  return pass(
    `Matched ${expected.name} (${formatUsd(expected.priceUsd)}) at ${expectedPath}.`,
  );
}

function compareOutOfStock(answer: CatalogOutOfStockAnswer): Comparison {
  const expectedNames = catalogTaskExpectations().outOfStock.map(
    (product) => product.name,
  );
  const expectedNormalized = expectedNames.map(normalizeTaskName);
  const actualNormalized = answer.names.map(normalizeTaskName);

  if (actualNormalized.length !== expectedNormalized.length) {
    return fail(
      `Expected ${expectedNormalized.length} product names but received ${actualNormalized.length}.`,
    );
  }
  const unique = new Set(actualNormalized);
  if (unique.size !== actualNormalized.length) {
    return fail("The answer contains duplicate product names.");
  }
  const missing = expectedNormalized.find((name) => !unique.has(name));
  if (missing !== undefined) {
    const index = expectedNormalized.indexOf(missing);
    return fail(`The answer is missing "${expectedNames[index] ?? missing}".`);
  }
  const unexpected = actualNormalized.find(
    (name) => !expectedNormalized.includes(name),
  );
  if (unexpected !== undefined) {
    const index = actualNormalized.indexOf(unexpected);
    return fail(
      `The answer includes an unexpected product name "${answer.names[index] ?? unexpected}".`,
    );
  }
  if (answer.count !== expectedNormalized.length) {
    return fail(
      `Expected count ${expectedNormalized.length} but received ${answer.count}.`,
    );
  }
  return pass(
    `Listed all ${expectedNormalized.length} out-of-stock products with count ${expectedNormalized.length}.`,
  );
}

function compareAudio(answer: CatalogAudioAnswer): Comparison {
  const expected = catalogTaskExpectations().audioUnder70;
  if (answer.items.length !== expected.length) {
    return fail(
      `Expected ${expected.length} Audio products but received ${answer.items.length}.`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedProduct = expected[index];
    const actual = answer.items[index];
    if (!expectedProduct || !actual) break;
    if (
      normalizeTaskName(actual.name) !== normalizeTaskName(expectedProduct.name)
    ) {
      return fail(
        `Item ${index + 1} should be "${expectedProduct.name}" but was "${actual.name}".`,
      );
    }
    if (actual.priceUsd !== expectedProduct.priceUsd) {
      return fail(
        `Item ${index + 1} should cost ${formatUsd(expectedProduct.priceUsd)} but was ${formatUsd(actual.priceUsd)}.`,
      );
    }
  }
  return pass(
    `Listed ${expected.length} in-stock Audio products below $70 in ascending price order.`,
  );
}

function compareCatalogAnswer(
  answer: CatalogTaskAnswer,
  origin: string,
): Comparison {
  switch (answer.presetId) {
    case "catalog-cheapest-home":
      return compareCheapestHome(answer.answer, origin);
    case "catalog-out-of-stock":
      return compareOutOfStock(answer.answer);
    case "catalog-audio-under-70":
      return compareAudio(answer.answer);
  }
}

function boundReason(reason: string): string {
  return reason.slice(0, 1_000);
}

/**
 * Business evaluation only. A custom or verification run is never evaluated;
 * an incomplete preset run fails because a limit/cancel is not a task pass.
 * UI evidence stays a separate run-record field.
 */
export function evaluateCatalogTaskRun(
  record: AgentRunRecord,
): AgentRunEvaluation {
  if (record.kind !== "task" || record.presetId === null) {
    return { status: "not_evaluated", reason: null };
  }
  if (record.status !== "completed") {
    return {
      status: "failed",
      reason: boundReason(
        record.error ??
          `The run ended as ${record.status} without completing the task.`,
      ),
    };
  }
  if (record.stopReason !== "completed") {
    return {
      status: "failed",
      reason: boundReason(
        `The SDK stopped the run (${record.stopReason ?? "unknown"}).`,
      ),
    };
  }
  const parsed = parseCatalogTaskAnswer(record.presetId, record.outputText);
  if (!parsed.ok) {
    return { status: "failed", reason: boundReason(parsed.reason) };
  }
  const comparison = compareCatalogAnswer(parsed.answer, record.origin);
  return {
    status: comparison.passed ? "passed" : "failed",
    reason: boundReason(comparison.reason),
  };
}
