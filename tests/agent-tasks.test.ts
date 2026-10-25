import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_CATALOG_TASK_IDS,
  AGENT_CATALOG_TASK_PRESETS,
  AGENT_FORM_TASK_PRESETS,
  AGENT_TASK_IDS,
  buildCatalogTaskInstruction,
  buildPresetTaskInstruction,
  getAgentFormTaskPreset,
  isAgentCatalogTaskId,
  isAgentPresetTaskId,
  parseCatalogTaskAnswer,
  parseFormTaskAnswer,
  parsePresetTaskAnswer,
} from "../src/lib/agent-tasks";
import {
  buildCatalogTaskSettler,
  catalogTaskExpectations,
  evaluateCatalogTaskRun,
} from "../src/server/agent-task-evaluator";
import {
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import { Storage } from "../src/server/storage";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
    kind: "task",
    presetId: "catalog-cheapest-home",
    uiMode: null,
    formBaseline: null,
    task: "Preset task",
    modelId: "openrouter/openai/gpt-5.6-luna",
    origin: "http://127.0.0.1:3000",
    limits: { maxSteps: 30, timeoutMs: 180_000, maxCostUsd: 1 },
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-10-24T10:00:00.000Z",
    endedAt: "2026-10-24T10:00:05.000Z",
    updatedAt: "2026-10-24T10:00:05.000Z",
    steps: 3,
    durationMs: 5_000,
    outputText: JSON.stringify({
      name: "Pebble Plant Pot",
      priceUsd: 22,
      url: "/shop/products/pebble-plant-pot",
    }),
    error: null,
    usage: null,
    imageInputObserved: false,
    vision: "unverified",
    evaluation: { status: "not_evaluated", reason: null },
    uiEvidence: "observed",
    worker: null,
    eventCount: 5,
    lastSeq: 5,
    cancelRequestedAt: null,
    cancelReason: null,
    watchdogExpiredAt: null,
    ...overrides,
  };
}

describe("catalog task presets", () => {
  it("defines exactly the three neutral catalog tasks", () => {
    expect(AGENT_CATALOG_TASK_IDS).toEqual([
      "catalog-cheapest-home",
      "catalog-out-of-stock",
      "catalog-audio-under-70",
    ]);
    expect(AGENT_CATALOG_TASK_PRESETS).toHaveLength(3);

    const expectations = catalogTaskExpectations();
    const expectedNames = [
      expectations.cheapestHome.name,
      ...expectations.outOfStock.map((product) => product.name),
      ...expectations.audioUnder70.map((product) => product.name),
    ];
    for (const preset of AGENT_CATALOG_TASK_PRESETS) {
      const instruction = buildCatalogTaskInstruction(
        "http://127.0.0.1:3000",
        preset.id,
      );
      expect(instruction).toContain("http://127.0.0.1:3000/shop");
      expect(instruction).toContain(preset.answerShape);
      for (const name of expectedNames) {
        expect(instruction).not.toContain(name);
      }
    }
  });

  it("recognizes only known preset IDs", () => {
    for (const id of AGENT_CATALOG_TASK_IDS) {
      expect(isAgentCatalogTaskId(id)).toBe(true);
    }
    expect(isAgentCatalogTaskId("custom")).toBe(false);
    expect(isAgentCatalogTaskId("catalog-unknown")).toBe(false);
  });

  it("derives the literal fixture expectations", () => {
    const expectations = catalogTaskExpectations();
    expect(expectations.cheapestHome).toMatchObject({
      id: "P19",
      name: "Pebble Plant Pot",
      category: "Home",
      priceUsd: 22,
      stock: 15,
      slug: "pebble-plant-pot",
    });
    expect(expectations.outOfStock.map((product) => product.name)).toEqual([
      "Atlas Travel Backpack",
      "Pulse Sport Earbuds",
      "Glow Aroma Diffuser",
      "Aero Laptop Stand",
    ]);
    expect(
      expectations.audioUnder70.map((product) => ({
        name: product.name,
        priceUsd: product.priceUsd,
      })),
    ).toEqual([
      { name: "Mini Bluetooth Radio", priceUsd: 44 },
      { name: "Echo Mini Speaker", priceUsd: 59 },
    ]);
  });
});

describe("form task presets", () => {
  it("defines Tasks 4-5 and five total presets", () => {
    expect(AGENT_TASK_IDS).toEqual([
      "catalog-cheapest-home",
      "catalog-out-of-stock",
      "catalog-audio-under-70",
      "form-support-request",
      "form-product-inquiry",
    ]);
    expect(AGENT_FORM_TASK_PRESETS).toHaveLength(2);

    const support = getAgentFormTaskPreset("form-support-request");
    expect(support).toMatchObject({
      form: "support",
      startPath: "/forms/support",
      expected: {
        fullName: "Alex Demo",
        email: "alex@example.com",
        subject: "Payment confirmation issue",
        priority: "High",
        description:
          "I did not receive a confirmation after the simulated payment.",
        confirmLocalTest: true,
      },
    });
    const supportInstruction = buildPresetTaskInstruction(
      "http://127.0.0.1:3000",
      support.id,
    );
    expect(supportInstruction).toContain(
      "http://127.0.0.1:3000/forms/support",
    );
    expect(supportInstruction).toContain(
      "Using the support form, submit name Alex Demo",
    );
    expect(supportInstruction).toContain(
      '{"requestId":"<support request UUID>"}',
    );

    const inquiry = getAgentFormTaskPreset("form-product-inquiry");
    expect(inquiry).toMatchObject({
      form: "inquiry",
      startPath: "/shop",
      expected: {
        productId: "P22",
        productName: "Clarity Webcam",
        inquiryType: "Specifications",
        message: "Does this webcam support 1080p video recording?",
      },
    });
    const inquiryInstruction = buildPresetTaskInstruction(
      "http://127.0.0.1:3000",
      inquiry.id,
    );
    expect(inquiryInstruction).toContain(
      "Find Clarity Webcam and use its inquiry form",
    );
    expect(inquiryInstruction).toContain(
      '{"confirmationId":"<inquiry confirmation UUID>"}',
    );
  });

  it("recognizes all preset IDs", () => {
    for (const id of AGENT_TASK_IDS) {
      expect(isAgentPresetTaskId(id)).toBe(true);
    }
    expect(isAgentPresetTaskId("custom")).toBe(false);
    expect(isAgentPresetTaskId("catalog-unknown")).toBe(false);
  });
});

describe("strict form answers", () => {
  const supportId = "33333333-3333-4333-8333-333333333333";
  const inquiryId = "44444444-4444-4444-8444-444444444444";

  it("accepts only the exact form answer shapes", () => {
    expect(
      parseFormTaskAnswer(
        "form-support-request",
        JSON.stringify({ requestId: supportId }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseFormTaskAnswer(
        "form-product-inquiry",
        JSON.stringify({ confirmationId: inquiryId }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parsePresetTaskAnswer(
        "form-support-request",
        JSON.stringify({ requestId: supportId }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseFormTaskAnswer(
        "form-support-request",
        JSON.stringify({ requestId: supportId, extra: true }),
      ).ok,
    ).toBe(false);
    expect(
      parseFormTaskAnswer(
        "form-support-request",
        JSON.stringify({ confirmationId: supportId }),
      ).ok,
    ).toBe(false);
    expect(
      parseFormTaskAnswer("form-support-request", "The request was accepted.")
        .ok,
    ).toBe(false);
    expect(
      parseFormTaskAnswer(
        "form-support-request",
        '{"requestId":"not-a-uuid"}',
      ).ok,
    ).toBe(false);
    expect(
      parseFormTaskAnswer(
        "form-support-request",
        `{"requestId":"${supportId}","requestId":"${inquiryId}"}`,
      ).ok,
    ).toBe(false);
  });
});

describe("strict catalog answers", () => {
  const valid = {
    name: "Pebble Plant Pot",
    priceUsd: 22,
    url: "/shop/products/pebble-plant-pot",
  };

  it("accepts only the exact neutral JSON shape", () => {
    expect(
      parseCatalogTaskAnswer("catalog-cheapest-home", JSON.stringify(valid)).ok,
    ).toBe(true);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        JSON.stringify({ ...valid, extra: true }),
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        "The cheapest Home product is the Pebble Plant Pot.",
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        JSON.stringify({ ...valid, priceUsd: "22" }),
      ).ok,
    ).toBe(false);
    expect(parseCatalogTaskAnswer("catalog-cheapest-home", "").ok).toBe(false);
    expect(parseCatalogTaskAnswer("catalog-cheapest-home", null).ok).toBe(
      false,
    );
  });

  it("rejects duplicate JSON keys as ambiguous", () => {
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        '{"name":"Wrong","name":"Pebble Plant Pot","priceUsd":22,"url":"/shop/products/pebble-plant-pot"}',
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        '{"na\\u006de":"Pebble Plant Pot","name":"Wrong","priceUsd":22,"url":"/shop/products/pebble-plant-pot"}',
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-audio-under-70",
        '{"items":[{"name":"Mini Bluetooth Radio","priceUsd":44,"priceUsd":45},{"name":"Echo Mini Speaker","priceUsd":59}]}',
      ).ok,
    ).toBe(false);
    expect(
      parseCatalogTaskAnswer(
        "catalog-audio-under-70",
        '{"items":[{"name":"Mini Bluetooth Radio","priceUsd":44},{"name":"Echo Mini Speaker","priceUsd":59}]}',
      ).ok,
    ).toBe(true);
    expect(
      parseCatalogTaskAnswer(
        "catalog-cheapest-home",
        '{"na\\u006de":"Pebble Plant Pot","priceUsd":22,"url":"/shop/products/pebble-plant-pot"}',
      ).ok,
    ).toBe(true);
  });
});

describe("catalog business evaluator", () => {
  it.each([
    ["relative", "/shop/products/pebble-plant-pot"],
    [
      "absolute",
      "http://127.0.0.1:3000/shop/products/pebble-plant-pot",
    ],
    [
      "trailing slash",
      "http://127.0.0.1:3000/shop/products/pebble-plant-pot/",
    ],
  ])("passes task 1 with a %s product URL", (_label, url) => {
    const record = makeRecord({
      outputText: JSON.stringify({
        name: "  PEBBLE   plant pot ",
        priceUsd: 22,
        url,
      }),
    });
    expect(evaluateCatalogTaskRun(record)).toMatchObject({
      status: "passed",
      reason: expect.stringContaining("Pebble Plant Pot"),
    });
  });

  it.each([
    [
      "a wrong name",
      {
        name: "Luna Desk Lamp",
        priceUsd: 22,
        url: "/shop/products/pebble-plant-pot",
      },
    ],
    [
      "a wrong price",
      {
        name: "Pebble Plant Pot",
        priceUsd: 24,
        url: "/shop/products/pebble-plant-pot",
      },
    ],
    [
      "a wrong product path",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "/shop/products/luna-desk-lamp",
      },
    ],
    [
      "an external origin",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "https://example.com/shop/products/pebble-plant-pot",
      },
    ],
    [
      "a localhost origin",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "http://localhost:3000/shop/products/pebble-plant-pot",
      },
    ],
    [
      "a different port",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "http://127.0.0.1:3001/shop/products/pebble-plant-pot",
      },
    ],
    [
      "a different scheme",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "https://127.0.0.1:3000/shop/products/pebble-plant-pot",
      },
    ],
    [
      "an extra key",
      {
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "/shop/products/pebble-plant-pot",
        extra: true,
      },
    ],
  ])("fails task 1 with %s", (_label, answer) => {
    const record = makeRecord({ outputText: JSON.stringify(answer) });
    expect(evaluateCatalogTaskRun(record).status).toBe("failed");
  });

  it("fails task 1 for missing fields, prose, and invalid JSON", () => {
    expect(
      evaluateCatalogTaskRun(
        makeRecord({
          outputText: '{"name":"Pebble Plant Pot","priceUsd":22}',
        }),
      ).status,
    ).toBe("failed");
    expect(
      evaluateCatalogTaskRun(
        makeRecord({
          outputText: "The cheapest product is the Pebble Plant Pot.",
        }),
      ).status,
    ).toBe("failed");
    expect(
      evaluateCatalogTaskRun(makeRecord({ outputText: "not json" })).status,
    ).toBe("failed");
  });

  it("passes task 2 with the complete out-of-stock set in any order", () => {
    const record = makeRecord({
      presetId: "catalog-out-of-stock",
      outputText: JSON.stringify({
        names: [
          "Aero Laptop Stand",
          "Atlas Travel Backpack",
          "Glow Aroma Diffuser",
          "Pulse Sport Earbuds",
        ],
        count: 4,
      }),
    });
    expect(evaluateCatalogTaskRun(record)).toMatchObject({
      status: "passed",
      reason: expect.stringContaining("4 out-of-stock products"),
    });
  });

  it.each([
    [
      "a partial set",
      {
        names: [
          "Atlas Travel Backpack",
          "Pulse Sport Earbuds",
          "Glow Aroma Diffuser",
        ],
        count: 3,
      },
    ],
    [
      "an extra name",
      {
        names: [
          "Atlas Travel Backpack",
          "Pulse Sport Earbuds",
          "Glow Aroma Diffuser",
          "Aero Laptop Stand",
          "Luna Desk Lamp",
        ],
        count: 5,
      },
    ],
    [
      "a duplicate name",
      {
        names: [
          "Atlas Travel Backpack",
          "Atlas Travel Backpack",
          "Glow Aroma Diffuser",
          "Aero Laptop Stand",
        ],
        count: 4,
      },
    ],
    [
      "a mismatched count",
      {
        names: [
          "Atlas Travel Backpack",
          "Pulse Sport Earbuds",
          "Glow Aroma Diffuser",
          "Aero Laptop Stand",
        ],
        count: 3,
      },
    ],
  ])("fails task 2 with %s", (_label, answer) => {
    const record = makeRecord({
      presetId: "catalog-out-of-stock",
      outputText: JSON.stringify(answer),
    });
    expect(evaluateCatalogTaskRun(record).status).toBe("failed");
  });

  it("passes task 3 only in ascending price order", () => {
    const record = makeRecord({
      presetId: "catalog-audio-under-70",
      outputText: JSON.stringify({
        items: [
          { name: "Mini Bluetooth Radio", priceUsd: 44 },
          { name: "Echo Mini Speaker", priceUsd: 59 },
        ],
      }),
    });
    expect(evaluateCatalogTaskRun(record)).toMatchObject({
      status: "passed",
      reason: expect.stringContaining("ascending price order"),
    });
  });

  it.each([
    [
      "reversed order",
      {
        items: [
          { name: "Echo Mini Speaker", priceUsd: 59 },
          { name: "Mini Bluetooth Radio", priceUsd: 44 },
        ],
      },
    ],
    [
      "an extra product",
      {
        items: [
          { name: "Mini Bluetooth Radio", priceUsd: 44 },
          { name: "Echo Mini Speaker", priceUsd: 59 },
          { name: "Orbit Wireless Headphones", priceUsd: 89 },
        ],
      },
    ],
    [
      "a wrong price",
      {
        items: [
          { name: "Mini Bluetooth Radio", priceUsd: 45 },
          { name: "Echo Mini Speaker", priceUsd: 59 },
        ],
      },
    ],
    [
      "a missing product",
      { items: [{ name: "Mini Bluetooth Radio", priceUsd: 44 }] },
    ],
  ])("fails task 3 with %s", (_label, answer) => {
    const record = makeRecord({
      presetId: "catalog-audio-under-70",
      outputText: JSON.stringify(answer),
    });
    expect(evaluateCatalogTaskRun(record).status).toBe("failed");
  });

  it("never evaluates custom or verification runs", () => {
    expect(evaluateCatalogTaskRun(makeRecord({ presetId: null }))).toEqual({
      status: "not_evaluated",
      reason: null,
    });
    expect(
      evaluateCatalogTaskRun(
        makeRecord({ kind: "verification", presetId: null }),
      ),
    ).toEqual({ status: "not_evaluated", reason: null });
  });

  it("fails a preset run that did not complete cleanly", () => {
    expect(
      evaluateCatalogTaskRun(
        makeRecord({ status: "failed", error: "The worker crashed." }),
      ),
    ).toMatchObject({ status: "failed", reason: "The worker crashed." });
    expect(
      evaluateCatalogTaskRun(makeRecord({ stopReason: "cancelled" })),
    ).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("cancelled"),
    });
  });
});

describe("catalog evaluation persistence", () => {
  it("persists the evaluation once and never rewrites it", async () => {
    const base = await mkdtemp(
      join(tmpdir(), "ai-browser-lab-agent-task-evaluator-"),
    );
    tempDirs.push(base);
    const storage = new Storage(join(base, "data"));
    const record = makeRecord();
    await saveAgentRun(storage, record);

    const settler = buildCatalogTaskSettler({
      storage,
      now: () => new Date("2026-10-24T11:00:00.000Z"),
    });
    await settler(record);
    const first = await loadAgentRun(storage, record.runId);
    expect(first).toMatchObject({
      evaluation: {
        status: "passed",
        reason: expect.stringContaining("Pebble Plant Pot"),
      },
      updatedAt: "2026-10-24T11:00:00.000Z",
    });

    await settler(makeRecord({ outputText: "not json" }));
    const second = await loadAgentRun(storage, record.runId);
    expect(second?.evaluation.status).toBe("passed");
    expect(second?.evaluation.reason).toBe(first?.evaluation.reason);
  });

  it("persists the in-memory terminal record when the terminal save failed", async () => {
    const base = await mkdtemp(
      join(tmpdir(), "ai-browser-lab-agent-task-evaluator-"),
    );
    tempDirs.push(base);
    const storage = new Storage(join(base, "data"));
    const stale = makeRecord({
      status: "running",
      stopReason: null,
      endedAt: null,
      outputText: null,
      evaluation: { status: "not_evaluated", reason: null },
    });
    await saveAgentRun(storage, stale);

    const settler = buildCatalogTaskSettler({ storage });
    await settler(makeRecord());
    const loaded = await loadAgentRun(storage, stale.runId);
    expect(loaded).toMatchObject({
      status: "completed",
      stopReason: "completed",
      evaluation: { status: "passed" },
    });
  });

  it("never evaluates a non-terminal record", async () => {
    const base = await mkdtemp(
      join(tmpdir(), "ai-browser-lab-agent-task-evaluator-"),
    );
    tempDirs.push(base);
    const storage = new Storage(join(base, "data"));
    const running = makeRecord({
      status: "running",
      stopReason: null,
      endedAt: null,
      outputText: null,
      evaluation: { status: "not_evaluated", reason: null },
    });
    await saveAgentRun(storage, running);

    const settler = buildCatalogTaskSettler({ storage });
    await settler(running);
    const loaded = await loadAgentRun(storage, running.runId);
    expect(loaded).toMatchObject({
      status: "running",
      evaluation: { status: "not_evaluated", reason: null },
    });
  });

  it("leaves custom and verification runs untouched", async () => {
    const base = await mkdtemp(
      join(tmpdir(), "ai-browser-lab-agent-task-evaluator-"),
    );
    tempDirs.push(base);
    const storage = new Storage(join(base, "data"));
    const settler = buildCatalogTaskSettler({ storage });

    const custom = makeRecord({ presetId: null });
    await saveAgentRun(storage, custom);
    await settler(custom);
    expect((await loadAgentRun(storage, custom.runId))?.evaluation.status).toBe(
      "not_evaluated",
    );

    const verification = makeRecord({
      runId: "22222222-2222-4222-8222-222222222222",
      kind: "verification",
      presetId: null,
    });
    await saveAgentRun(storage, verification);
    await settler(verification);
    expect(
      (await loadAgentRun(storage, verification.runId))?.evaluation.status,
    ).toBe("not_evaluated");
  });

  it("ignores a run whose record does not exist", async () => {
    const base = await mkdtemp(
      join(tmpdir(), "ai-browser-lab-agent-task-evaluator-"),
    );
    tempDirs.push(base);
    const storage = new Storage(join(base, "data"));
    const settler = buildCatalogTaskSettler({ storage });
    await expect(settler(makeRecord())).resolves.toBeUndefined();
  });
});
