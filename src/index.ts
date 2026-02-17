/**
 * @ai-office/adversary-gate-replay-guard
 *
 * Reliability module that suppresses stale adversary gate event replays
 * after a task has advanced to a terminal state (done/canceled).
 *
 * Two guards are enforced:
 * 1. Terminal-state transition guard — events targeting done/canceled tasks are no-ops.
 * 2. Consumer idempotency guard — duplicate event deliveries (same eventId) are no-ops.
 */

export { AdversaryGateGuard } from "./guard.js";
export type { GuardConfig } from "./guard.js";

export { InMemoryTaskStore, InMemoryEventLedger } from "./stores.js";

export type {
  TaskStatus,
  TaskSnapshot,
  AdversaryGateEvent,
  EventProcessingResult,
  TaskStore,
  EventLedger,
} from "./types.js";

export { TASK_STATUSES, TERMINAL_STATES } from "./types.js";
