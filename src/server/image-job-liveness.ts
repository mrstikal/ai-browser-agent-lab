import { activeImageBatchJobId } from "./image-batch";
import { admittedImageJobId } from "./image-job";
import type { ImageJobSnapshot } from "./image-state";
import type { Storage } from "./storage";

const testLiveJobs = new Map<string, string>();

// Test-only: simulates an in-process admitted/active batch for wiring tests.
export function markImageJobLiveForTests(storage: Storage, jobId: string): void {
  testLiveJobs.set(storage.root, jobId);
}

export function resetImageJobLivenessForTests(): void {
  testLiveJobs.clear();
}

/**
 * A persisted active status is not proof that this process still owns the
 * batch: a restart leaves the old snapshot behind. The in-process admission
 * and batch controller are the authoritative liveness signals.
 */
export function isImageJobLive(
  storage: Storage,
  job: ImageJobSnapshot | null | undefined,
): boolean {
  if (!job) return false;
  return (
    testLiveJobs.get(storage.root) === job.jobId ||
    admittedImageJobId(storage) === job.jobId ||
    activeImageBatchJobId(storage) === job.jobId
  );
}
