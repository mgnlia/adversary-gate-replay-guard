/**
 * adversary-gate-replay-guard / Phase A — Patch 2
 *
 * Consumer idempotency guard for autopilotNudgeAdversaryReviewQueue in:
 *   packages/backend/src/scheduler/jobs.ts
 *
 * APPLY: Wrap the existing adversary review queue logic with the
 * in-flight tracking set and re-verification check described below.
 */

// ─── In-flight tracking set (module-level in jobs.ts) ────────────────────────

/**
 * Tracks task IDs that have an in-flight adversary review message.
 * Prevents duplicate adversary gate events when the scheduler fires
 * faster than the adversary agent can process verdicts.
 *
 * Entries are added when a message is sent to the adversary, and
 * removed when the task's adversary:pending tag is cleared (either
 * by verdict processing or terminal-state transition guard).
 */
const adversaryInFlightTaskIds = new Set<string>();

/**
 * Clear a task from the in-flight set. Called when:
 * - Adversary processes a verdict (pass/fail)
 * - Task transitions to terminal state
 * - Periodic cleanup detects stale entries
 */
function clearAdversaryInFlight(taskId: string): void {
  adversaryInFlightTaskIds.delete(taskId);
}

/**
 * Check if a task is already being reviewed by the adversary.
 */
function isAdversaryInFlight(taskId: string): boolean {
  return adversaryInFlightTaskIds.has(taskId);
}

/**
 * Mark a task as having an in-flight adversary review.
 */
function markAdversaryInFlight(taskId: string): void {
  adversaryInFlightTaskIds.add(taskId);
}

// ─── Re-verification guard ──────────────────────────────────────────────────

/**
 * Before sending an adversary review message, re-verify the task is still
 * in the `review` state. This closes the race window between the initial
 * listTasks query and the message send.
 *
 * Integration in autopilotNudgeAdversaryReviewQueue:
 *
 * BEFORE (existing code):
 *   for (const task of gated) {
 *     // ... tag checks ...
 *     // ... send message ...
 *   }
 *
 * AFTER (patched code):
 *   for (const task of gated) {
 *     // Skip if already in-flight (idempotency guard)
 *     if (isAdversaryInFlight(task.id)) continue;
 *
 *     // ... existing tag checks ...
 *
 *     // Re-verify task is still in review state (race guard)
 *     const freshTask = await repo.getTask(task.id);
 *     if (!freshTask || freshTask.status !== "review") {
 *       // Task state advanced since our query — skip
 *       clearAdversaryInFlight(task.id);
 *       continue;
 *     }
 *
 *     // ... add pending tag and collect into newlyQueued ...
 *     markAdversaryInFlight(task.id);
 *   }
 */

// ─── Periodic cleanup for stale in-flight entries ───────────────────────────

const ADVERSARY_INFLIGHT_STALE_MS = 10 * 60_000; // 10 minutes
const adversaryInFlightTimestamps = new Map<string, number>();

function markAdversaryInFlightWithTimestamp(taskId: string): void {
  adversaryInFlightTaskIds.add(taskId);
  adversaryInFlightTimestamps.set(taskId, Date.now());
}

function cleanupStaleAdversaryInFlight(): void {
  const cutoff = Date.now() - ADVERSARY_INFLIGHT_STALE_MS;
  for (const [taskId, timestamp] of adversaryInFlightTimestamps) {
    if (timestamp < cutoff) {
      adversaryInFlightTaskIds.delete(taskId);
      adversaryInFlightTimestamps.delete(taskId);
    }
  }
}

export {
  adversaryInFlightTaskIds,
  clearAdversaryInFlight,
  isAdversaryInFlight,
  markAdversaryInFlight,
  markAdversaryInFlightWithTimestamp,
  cleanupStaleAdversaryInFlight,
};
