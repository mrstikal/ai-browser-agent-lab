export class PaidOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaidOperationError";
  }
}

export class PaidOperationActiveError extends PaidOperationError {
  readonly ownerId: string;

  constructor(ownerId: string) {
    super(
      `Paid operation ${ownerId} is active. Wait for it to finish before changing credentials or starting another paid job.`,
    );
    this.name = "PaidOperationActiveError";
    this.ownerId = ownerId;
  }
}

export interface ActivePaidOperation {
  readonly ownerId: string;
  readonly kind: string;
  readonly startedAt: string;
}

const PAID_OPERATION_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.paid-operation-holder",
);

interface PaidOperationHolder {
  readonly owners: Map<string, ActivePaidOperation>;
}

function holder(): PaidOperationHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[PAID_OPERATION_HOLDER_KEY] as
    | PaidOperationHolder
    | undefined;
  if (existing) return existing;
  const created: PaidOperationHolder = { owners: new Map() };
  host[PAID_OPERATION_HOLDER_KEY] = created;
  return created;
}

export function beginPaidOperation(ownerId: string, kind = "paid"): void {
  if (!ownerId || ownerId.length > 128 || /[\u0000-\u001f\u007f]/.test(ownerId)) {
    throw new PaidOperationError("Paid operation ownerId must be a bounded string.");
  }
  const state = holder();
  const active = state.owners.values().next().value as
    | ActivePaidOperation
    | undefined;
  if (active) throw new PaidOperationActiveError(active.ownerId);
  state.owners.set(ownerId, {
    ownerId,
    kind,
    startedAt: new Date().toISOString(),
  });
}

export function endPaidOperation(ownerId: string): boolean {
  return holder().owners.delete(ownerId);
}

export function activePaidOperation(): ActivePaidOperation | null {
  const active = holder().owners.values().next().value as
    | ActivePaidOperation
    | undefined;
  return active ?? null;
}

export function isPaidOperationActive(): boolean {
  return holder().owners.size > 0;
}

// Test-only: clears the in-process paid-operation registry.
export function resetPaidOperationsForTests(): void {
  holder().owners.clear();
}

export function assertNoActivePaidOperation(): void {
  const active = activePaidOperation();
  if (active) throw new PaidOperationActiveError(active.ownerId);
}
