/**
 * Core types for the adversary-gate-replay-guard module.
 *
 * Mirrors the canonical types from @ai-office/shared where applicable,
 * while keeping this module self-contained and testable without the
 * full monorepo.
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

// ── Task priorities ─────────────────────────────────────────

export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// ── Terminal states ─────────────────────────────────────────

/**
 * Terminal states are states from which no further adversary gate
 * transitions should be applied. Once a task reaches one of these,
 * any stale gate event must be silently discarded.
 */
export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set(["done"]);

// ── Lightweight task shape for guard logic ──────────────────

export interface TaskSnapshot {
  id: string;
  status: TaskStatus;
  /** Optimistic concurrency version counter. */
  version: number;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

// ── Gate event types ────────────────────────────────────────

/**
 * Actions the adversary agent can take on a task.
 *
 * - challenge:        adversary challenges the task quality
 * - reject:           adversary rejects the deliverable
 * - request_changes:  adversary requests specific changes
 * - block:            adversary blocks the task from progressing
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
  /** ISO-8601 timestamp when the event was originally created. */
  createdAt: string;
  /** Optional arbitrary payload. */
  payload?: Record<string, unknown>;
}

// ── Event processing result ─────────────────────────────────

export interface EventProcessingResult {
  /** Whether the event was applied to the task. */
  applied: boolean;
  /** Human-readable reason when suppressed. */
  reason?: string;
  /** The event ID that was processed. */
  eventId: string;
  /** The task ID targeted by the event. */
  taskId: string;
}

// ── Store interfaces ────────────────────────────────────────

/**
 * Abstraction over task persistence. In tests, backed by an in-memory
 * Map. In production, backed by Postgres via the office backend.
 */
export interface TaskStore {
  getTask(taskId: string): Promise<TaskSnapshot | null>;
  updateTask(
    taskId: string,
    update: Partial<Pick<TaskSnapshot, "status" | "version">>
  ): Promise<TaskSnapshot | null>;
}

/**
 * Abstraction over the processed-event ledger for idempotency.
 * Tracks which eventIds have already been handled.
 */
export interface EventLedger {
  hasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}
