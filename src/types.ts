/**
 * Core types for the adversary-gate-replay-guard module.
 *
 * Mirrors the canonical types in packages/shared/src/types.ts and
 * packages/shared/src/enums.ts from the main office repo, but kept
 * self-contained for independent testing and deployment.
 */

// ── Task statuses (matches TASK_STATUSES enum) ──────────────

export const TASK_STATUSES = [
  "backlog",
  "needs_clarification",
  "todo",
  "in_progress",
  "review",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── Terminal states ─────────────────────────────────────────

/**
 * Terminal states are states from which no further adversary gate
 * transitions should be applied. Once a task reaches one of these,
 * any stale gate event must be silently discarded.
 *
 * Currently only "done" is terminal in the office schema (there is no
 * "canceled" status). If one is added later, include it here.
 */
export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set(["done"]);

// ── Adversary gate tags ─────────────────────────────────────

export const ADVERSARY_PENDING_TAG = "adversary:pending";
export const ADVERSARY_PASS_TAG = "adversary:pass";

// ── Lightweight task snapshot for guard logic ───────────────

export interface TaskSnapshot {
  id: string;
  status: TaskStatus;
  /** Optimistic-concurrency version counter. */
  version: number;
  updatedAt: string; // ISO-8601
}

// ── Adversary gate event ────────────────────────────────────

/**
 * Actions the adversary gate can emit. These map to state mutations
 * on the target task:
 *
 * - challenge  → task moves to "review"
 * - reject     → task moves to "review"
 * - request_changes → task moves to "needs_clarification"
 * - block      → task moves to "needs_clarification"
 */
export type AdversaryGateAction =
  | "challenge"
  | "reject"
  | "request_changes"
  | "block";

export interface AdversaryGateEvent {
  /** Unique event identifier for idempotency. */
  eventId: string;
  /** The task this event targets. */
  taskId: string;
  /** The adversary action to apply. */
  action: AdversaryGateAction;
  /** ISO-8601 timestamp when the event was originally produced. */
  createdAt: string;
  /** Optional extra data; guard ignores but passes through. */
  payload?: Record<string, unknown>;
}

// ── Processing result ───────────────────────────────────────

export interface EventProcessingResult {
  applied: boolean;
  reason?: string;
  eventId: string;
  taskId: string;
}

// ── Store interfaces ────────────────────────────────────────

/**
 * Minimal task store interface. In production this wraps the Postgres
 * repository; in tests the InMemoryTaskStore is used.
 */
export interface TaskStore {
  getTask(taskId: string): Promise<TaskSnapshot | null>;
  updateTask(
    taskId: string,
    update: Partial<Pick<TaskSnapshot, "status" | "version">>,
  ): Promise<TaskSnapshot | null>;
}

/**
 * Event ledger for idempotency tracking. Records which event IDs
 * have already been processed so duplicates are no-ops.
 */
export interface EventLedger {
  hasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}
