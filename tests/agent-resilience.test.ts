import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentRunSummary } from "@/lib/agent-history";
import {
  AGENT_RESILIENCE_MIN_SAMPLE,
  buildAgentResilienceComparison,
  describeResilienceSample,
  resilienceModes,
} from "@/lib/agent-resilience";

function summary(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    runId: randomUUID(),
    kind: "task",
    presetId: "catalog-cheapest-home",
    modelId: "model-a",
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-10-25T12:00:00.000Z",
    endedAt: "2026-10-25T12:00:01.000Z",
    durationMs: 1_000,
    steps: 3,
    usage: null,
    evaluation: { status: "passed", reason: null },
    uiEvidence: "observed",
    pageEvidence: "observed",
    vision: "unverified",
    uiMode: "classic",
    errorSummary: null,
    ...overrides,
  };
}

describe("agent resilience comparison", () => {
  it("counts strict full passes and business passes by model, task, and mode", () => {
    const comparison = buildAgentResilienceComparison([
      summary(),
      summary({
        evaluation: { status: "failed", reason: "wrong answer" },
      }),
      summary({ uiEvidence: "unverified" }),
      summary({ uiMode: "alternate" }),
      summary({ uiMode: "alternate" }),
      summary({
        uiMode: "alternate",
        stopReason: "cancelled",
        evaluation: { status: "passed", reason: null },
      }),
    ]);

    expect(comparison.groups).toHaveLength(1);
    const group = comparison.groups[0];
    expect(group).toBeDefined();
    expect(group?.comparable).toBe(true);
    expect(group?.modes.classic).toMatchObject({
      fullPasses: 1,
      businessPasses: 2,
      sampleSize: 3,
    });
    expect(group?.modes.alternate).toMatchObject({
      fullPasses: 2,
      businessPasses: 3,
      sampleSize: 3,
    });
    expect(comparison.exclusions).toEqual({
      noMode: 0,
      active: 0,
      nonPreset: 0,
    });
  });

  it("excludes active, custom, verification, and uncaptured-mode runs", () => {
    const comparison = buildAgentResilienceComparison([
      summary({ kind: "verification", presetId: null }),
      summary({ presetId: null }),
      summary({ uiMode: null }),
      summary({
        status: "running",
        stopReason: null,
        endedAt: null,
        evaluation: { status: "not_evaluated", reason: null },
      }),
    ]);

    expect(comparison.groups).toHaveLength(0);
    expect(comparison.exclusions).toEqual({
      noMode: 1,
      active: 1,
      nonPreset: 2,
    });
  });

  it("keeps both modes for each model/task group and marks incomplete pairs", () => {
    const comparison = buildAgentResilienceComparison([
      summary({ modelId: "model-b", presetId: "catalog-out-of-stock" }),
      summary({ modelId: "model-a", presetId: "form-product-inquiry" }),
      summary({ modelId: "model-a", presetId: "catalog-cheapest-home" }),
    ]);

    expect(
      comparison.groups.map((group) => [group.modelId, group.presetId]),
    ).toEqual([
      ["model-a", "catalog-cheapest-home"],
      ["model-a", "form-product-inquiry"],
      ["model-b", "catalog-out-of-stock"],
    ]);
    expect(comparison.groups.every((group) => !group.comparable)).toBe(true);
    for (const group of comparison.groups) {
      expect(group.modes.classic.sampleSize).toBe(1);
      expect(group.modes.alternate.sampleSize).toBe(0);
    }
  });

  it("never presents a single run as statistically reliable evidence", () => {
    const single = describeResilienceSample(1);
    expect(single.label).toBe("Single run");
    expect(single.detail).toContain("not statistically reliable");
    expect(single.statisticallyReliable).toBe(false);

    const small = describeResilienceSample(AGENT_RESILIENCE_MIN_SAMPLE - 1);
    expect(small.label).toBe("Small sample");
    expect(small.statisticallyReliable).toBe(false);

    const descriptive = describeResilienceSample(
      AGENT_RESILIENCE_MIN_SAMPLE,
    );
    expect(descriptive.label).toBe("Descriptive counts");
    expect(descriptive.statisticallyReliable).toBe(false);
  });

  it("exposes the fixed mode order", () => {
    expect(resilienceModes()).toEqual(["classic", "alternate"]);
  });
});
