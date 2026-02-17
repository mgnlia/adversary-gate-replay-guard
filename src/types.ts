/**
 * Minimal type surface extracted from @ai-office/shared to keep this module
 * self-contained and testable without pulling in the full monorepo.
 *
 * These mirror the canonical types in packages/shared/src/types.ts and
 * packages/shared/src/enums.ts.
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

// ── Adversary gate tags ─────────────────────────────────────

export const ADVERSARY_PENDING_TAG = "adversary:pending";
export const ADVERSARY_PASS_TAG = "adversary:pass";

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
  priority: TaskPriority;
  tags: string[];
  updatedAt: string; // ISO-8601
}

// ── Gate event types ────────────────────────────────────────

export type AdversaryGateAction =
  | "queue_pending"   // autopilot adds adversary:pending tag
  | "verdict_pass"    // adversary marks pass, removes pending
  | "verdict_fail";   // adversary moves task back to in_progress

export interface AdversaryGateEvent {
  action: AdversaryGateAction;
  taskId: string;
  /** ISO-8601 timestamp when the event was originally produced */
  producedAt: string;
  /** Optional dedup key; defaults to `${action}:${taskId}:${producedAt}` */
  idempotencyKey?: string;
}

// ── Guard result ────────────────────────────────────────────

export type GuardVerdict = "accept" | "reject_terminal" | "reject_duplicate";

export interface GuardResult {
  verdict: GuardVerdict;
  reason: string;
  event: AdversaryGateEvent;
  taskSnapshot: TaskSnapshot;
}
