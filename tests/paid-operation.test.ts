import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activePaidOperation,
  assertNoActivePaidOperation,
  beginPaidOperation,
  endPaidOperation,
  isPaidOperationActive,
  PaidOperationActiveError,
  PaidOperationError,
  resetPaidOperationsForTests,
} from "../src/server/paid-operation";

afterEach(() => {
  resetPaidOperationsForTests();
});

describe("paid operation registry", () => {
  it("allows one active paid operation at a time", () => {
    expect(isPaidOperationActive()).toBe(false);
    beginPaidOperation("job-1", "image");
    expect(isPaidOperationActive()).toBe(true);
    expect(activePaidOperation()).toMatchObject({
      ownerId: "job-1",
      kind: "image",
    });

    expect(() => beginPaidOperation("job-2", "image")).toThrow(
      PaidOperationActiveError,
    );
    expect(() => assertNoActivePaidOperation()).toThrow(PaidOperationActiveError);

    expect(endPaidOperation("job-1")).toBe(true);
    expect(endPaidOperation("job-1")).toBe(false);
    expect(isPaidOperationActive()).toBe(false);
    expect(() => assertNoActivePaidOperation()).not.toThrow();
  });

  it("rejects invalid owners and keeps state across module reloads", () => {
    expect(() => beginPaidOperation("")).toThrow(PaidOperationError);
    expect(() => beginPaidOperation("x".repeat(200))).toThrow(PaidOperationError);

    beginPaidOperation("job-hmr", "agent");
    vi.resetModules();
    return import("../src/server/paid-operation").then((reloaded) => {
      expect(reloaded.activePaidOperation()).toMatchObject({
        ownerId: "job-hmr",
        kind: "agent",
      });
      expect(reloaded.endPaidOperation("job-hmr")).toBe(true);
    });
  });
});
