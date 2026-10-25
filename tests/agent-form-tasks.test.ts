import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_FORM_BASELINE_MAX_IDS } from "../src/lib/agent-tasks";
import {
  AgentFormBaselineLimitError,
  assertFormBaselineSize,
  captureFormBaseline,
  listFormSubmissionIds,
} from "../src/server/agent-form-baseline";
import {
  loadAgentRun,
  saveAgentRun,
  type AgentRunRecord,
} from "../src/server/agent-runs";
import {
  buildPresetTaskSettler,
  evaluateFormTaskRun,
  evaluatePresetTaskRun,
} from "../src/server/agent-task-evaluator";
import {
  saveInquirySubmission,
} from "../src/server/inquiry-form";
import {
  listSupportSubmissionIds,
  saveSupportSubmission,
} from "../src/server/support-form";
import { resetSubmissions } from "../src/server/submissions-view";
import { Storage } from "../src/server/storage";

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const OLD_SUPPORT_ID = "66666666-6666-4666-8666-666666666666";
const NEW_SUPPORT_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_SUPPORT_ID = "88888888-8888-4888-8888-888888888888";
const OLD_INQUIRY_ID = "99999999-9999-4999-8999-999999999999";
const NEW_INQUIRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-form-task-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

function makeRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 2,
    runId: RUN_ID,
    kind: "task",
    presetId: "form-support-request",
    formBaseline: { form: "support", submissionIds: [] },
    task: "Form preset task",
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
    outputText: null,
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

async function seedSupport(
  storage: Storage,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return saveSupportSubmission(storage, {
    requestId,
    fullName: "Alex Demo",
    email: "alex@example.com",
    subject: "Payment confirmation issue",
    priority: "High",
    description:
      "I did not receive a confirmation after the simulated payment.",
    confirmLocalTest: true,
    ...overrides,
  });
}

async function seedInquiry(
  storage: Storage,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return saveInquirySubmission(storage, {
    requestId,
    fullName: "Alex Demo",
    email: "alex@example.com",
    productId: "P22",
    inquiryType: "Specifications",
    message: "Does this webcam support 1080p video recording?",
    ...overrides,
  });
}

describe("form task baseline", () => {
  it("captures existing IDs for the task's form type only", async () => {
    const storage = await makeStorage();
    await seedSupport(storage, OLD_SUPPORT_ID);
    await seedInquiry(storage, OLD_INQUIRY_ID);

    expect(await captureFormBaseline(storage, "form-support-request")).toEqual({
      form: "support",
      submissionIds: [OLD_SUPPORT_ID],
    });
    expect(await captureFormBaseline(storage, "form-product-inquiry")).toEqual({
      form: "inquiry",
      submissionIds: [OLD_INQUIRY_ID],
    });
    expect(
      await captureFormBaseline(storage, "catalog-cheapest-home"),
    ).toBeNull();
    expect(await listFormSubmissionIds(storage, "support")).toEqual([
      OLD_SUPPORT_ID,
    ]);
  });
});

describe("form baseline bounds", () => {
  it("rejects a baseline above the configured cap", () => {
    expect(() =>
      assertFormBaselineSize("support", AGENT_FORM_BASELINE_MAX_IDS),
    ).not.toThrow();
    expect(() =>
      assertFormBaselineSize("support", AGENT_FORM_BASELINE_MAX_IDS + 1),
    ).toThrow(AgentFormBaselineLimitError);
  });
});

describe("form business evaluator", () => {
  it("passes exactly one new matching support record with its returned ID", async () => {
    const storage = await makeStorage();
    await seedSupport(storage, OLD_SUPPORT_ID);
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID);

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: created.id }),
    });
    expect(await evaluateFormTaskRun(record, storage)).toMatchObject({
      status: "passed",
      reason: expect.stringContaining("all prescribed fields"),
    });
  });

  it("fails an old matching record because it is in the baseline", async () => {
    const storage = await makeStorage();
    const old = await seedSupport(storage, OLD_SUPPORT_ID);
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: old.id }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("exactly one new support submission");
  });

  it("fails a wrong returned ID even when one new record exists", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    await seedSupport(storage, NEW_SUPPORT_ID);

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("does not identify");
  });

  it("fails a duplicate submit because two new records exist", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const first = await seedSupport(storage, NEW_SUPPORT_ID);
    await seedSupport(storage, SECOND_SUPPORT_ID);

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: first.id }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("found 2");
  });

  it("fails a new record with an incorrect field", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID, {
      subject: "Wrong subject",
    });

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: created.id }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Expected support subject");
  });

  it("fails when the baseline is missing or for the wrong form", async () => {
    const storage = await makeStorage();
    const created = await seedSupport(storage, NEW_SUPPORT_ID);

    const missing = makeRecord({
      formBaseline: null,
      outputText: JSON.stringify({ requestId: created.id }),
    });
    expect((await evaluateFormTaskRun(missing, storage)).reason).toContain(
      "no form submission baseline",
    );

    const wrongForm = makeRecord({
      formBaseline: { form: "inquiry", submissionIds: [] },
      outputText: JSON.stringify({ requestId: created.id }),
    });
    expect((await evaluateFormTaskRun(wrongForm, storage)).reason).toContain(
      "baseline type",
    );
  });

  it("fails a non-completed form run even if a record exists", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID);
    const record = makeRecord({
      formBaseline: baseline,
      status: "failed",
      error: "The worker crashed.",
      outputText: JSON.stringify({ requestId: created.id }),
    });
    expect(await evaluateFormTaskRun(record, storage)).toMatchObject({
      status: "failed",
      reason: "The worker crashed.",
    });
  });

  it("fails a completed form run stopped by a limit", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID);
    const record = makeRecord({
      formBaseline: baseline,
      stopReason: "max_steps",
      outputText: JSON.stringify({ requestId: created.id }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("max_steps");
  });

  it("never evaluates custom or verification runs", async () => {
    const storage = await makeStorage();
    expect(
      await evaluateFormTaskRun(makeRecord({ presetId: null }), storage),
    ).toEqual({ status: "not_evaluated", reason: null });
    expect(
      await evaluateFormTaskRun(
        makeRecord({ kind: "verification", presetId: null }),
        storage,
      ),
    ).toEqual({ status: "not_evaluated", reason: null });
  });

  it("passes exactly one new matching inquiry record with P22", async () => {
    const storage = await makeStorage();
    await seedInquiry(storage, OLD_INQUIRY_ID);
    const baseline = await captureFormBaseline(
      storage,
      "form-product-inquiry",
    );
    const created = await seedInquiry(storage, NEW_INQUIRY_ID);

    const record = makeRecord({
      presetId: "form-product-inquiry",
      formBaseline: baseline,
      outputText: JSON.stringify({ confirmationId: created.id }),
    });
    expect(await evaluateFormTaskRun(record, storage)).toMatchObject({
      status: "passed",
      reason: expect.stringContaining("product P22"),
    });
  });

  it("fails an inquiry record with the wrong product", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-product-inquiry",
    );
    const created = await seedInquiry(storage, NEW_INQUIRY_ID, {
      productId: "P05",
    });

    const record = makeRecord({
      presetId: "form-product-inquiry",
      formBaseline: baseline,
      outputText: JSON.stringify({ confirmationId: created.id }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Expected inquiry product P22");
  });

  it("fails an unreadable new record", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    await storage.writeFile(
      ["submissions", "support", `${NEW_SUPPORT_ID}.json`],
      "{not a record",
    );

    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: NEW_SUPPORT_ID }),
    });
    const result = await evaluateFormTaskRun(record, storage);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("could not be read");
  });

  it("dispatches catalog and form presets through one evaluator", async () => {
    const storage = await makeStorage();
    const catalog = makeRecord({
      presetId: "catalog-cheapest-home",
      formBaseline: null,
      outputText: JSON.stringify({
        name: "Pebble Plant Pot",
        priceUsd: 22,
        url: "/shop/products/pebble-plant-pot",
      }),
    });
    expect(await evaluatePresetTaskRun(catalog, storage)).toMatchObject({
      status: "passed",
    });

    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID);
    const form = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: created.id }),
    });
    expect(await evaluatePresetTaskRun(form, storage)).toMatchObject({
      status: "passed",
    });
  });
});

describe("form evaluation persistence", () => {
  it("persists the form evaluation once and never rewrites it", async () => {
    const storage = await makeStorage();
    const baseline = await captureFormBaseline(
      storage,
      "form-support-request",
    );
    const created = await seedSupport(storage, NEW_SUPPORT_ID);
    const record = makeRecord({
      formBaseline: baseline,
      outputText: JSON.stringify({ requestId: created.id }),
    });
    await saveAgentRun(storage, record);

    const settler = buildPresetTaskSettler({
      storage,
      now: () => new Date("2026-10-24T11:00:00.000Z"),
    });
    await settler(record);
    const first = await loadAgentRun(storage, record.runId);
    expect(first).toMatchObject({
      evaluation: { status: "passed" },
      updatedAt: "2026-10-24T11:00:00.000Z",
    });

    await resetSubmissions(storage);
    expect(await listSupportSubmissionIds(storage)).toEqual([]);

    await settler(record);
    const second = await loadAgentRun(storage, record.runId);
    expect(second?.evaluation.status).toBe("passed");
    expect(second?.evaluation.reason).toBe(first?.evaluation.reason);
  });
});
