/**
 * Terminal-State Transition Guard
 *
 * Prevents adversary gate events from being applied to tasks that have
 * already reached a terminal state (done). This is the first line of
 * defense against stale replay — if a task has been marked done while
 * the adversary was still processing a review, the belated verdict
 * (pass or fail) must be silently dropped.
 *
 * Design rationale:
 * - The adversary gate scheduler (`autopilotNudgeAdversaryReviewQueue`)
 *   fires periodically and enqueues review requests for high/critical
 *   tasks in "review" state. Between the time the event is produced and
 *   the adversary processes it, the CSO may have already approved and
 *   moved the task to "done".
 * - Without this guard, a stale "verdict_fail" could regress a completed
 *   task back to "in_progress", causing phantom work and confusion.
 */

import type {
  AdversaryGateEvent,
  GuardResult,
  TaskSnapshot,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";

/**
 * Evaluate whether an adversary gate event should be applied to the
 * current task state.
 *
 * @returns GuardResult with verdict "accept" or "reject_terminal"
 */
export function evaluateTerminalStateGuard(
  event: AdversaryGateEvent,
  task: TaskSnapshot,
): GuardResult {
  if (TERMINAL_STATES.has(task.status)) {
    return {
      verdict: "reject_terminal",
      reason:
        `Task ${task.id} is in terminal state "${task.status}"; ` +
        `adversary gate action "${event.action}" produced at ${event.producedAt} is stale and will be discarded.`,
      event,
      taskSnapshot: task,
    };
  }

  // Additional staleness check: if the event was produced before the task's
  // last update, the task may have advanced past the state the event was
  // targeting. For terminal-state guard we only hard-reject on terminal;
  // the timestamp-based staleness is advisory and logged but not blocking
  // (the idempotency guard handles the duplicate-delivery case).
  const eventProducedMs = Date.parse(event.producedAt);
  const taskUpdatedMs = Date.parse(task.updatedAt);

  if (
    Number.isFinite(eventProducedMs) &&
    Number.isFinite(taskUpdatedMs) &&
    eventProducedMs < taskUpdatedMs
  ) {
    // Not terminal, but the event is older than the task's last update.
    // We still accept it — the idempotency guard will catch true dupes.
    // This path exists for observability; callers can log the age delta.
  }

  return {
    verdict: "accept",
    reason: `Task ${task.id} is in state "${task.status}"; adversary gate action "${event.action}" is valid.`,
    event,
    taskSnapshot: task,
  };
}

/**
 * Quick boolean check — useful for inline guards in hot paths.
 */
export function isTaskInTerminalState(task: TaskSnapshot): boolean {
  return TERMINAL_STATES.has(task.status);
}
