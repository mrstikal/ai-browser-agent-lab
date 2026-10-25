/**
 * One paid operation at a time: image batches and supervised agent runs share
 * this lock file. The lock metadata `kind` distinguishes the holder while the
 * `ownerId` is the image job ID or agent run ID.
 */
export const PAID_JOB_LOCK_SEGMENTS = ["locks", "paid-job.lock"] as const;
export const PAID_JOB_LOCK_KIND = "paid-job";
export const AGENT_RUN_LOCK_KIND = "agent-run";
export const SUBMISSIONS_RESET_LOCK_KIND = "submissions-reset";
