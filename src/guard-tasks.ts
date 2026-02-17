/**
 * adversary-gate-replay-guard / Phase A — Patch 1
 *
 * Terminal-state transition guard for updateTask in:
 *   packages/backend/src/db/repository/tasks.ts
 *
 * APPLY: Insert the following block into the `updateTask` function body,
 * immediately after the tags array is finalized (merged/normalized) and
 * before the SQL UPDATE statement is constructed.
 *
 * This ensures that when a task transitions to a terminal state (done, backlog),
 * all adversary gate tags are automatically stripped — preventing stale replay.
 */

// ─── Constants (add near existing ADVERSARY_PASS_TAG / ADVERSARY_PENDING_TAG) ───

const ADVERSARY_GATE_TAGS = ["adversary:pass", "adversary:pending"] as const;
const TERMINAL_TASK_STATUSES = new Set(["done", "backlog"]);

// ─── Guard logic (insert into updateTask after tag normalization) ────────────

/**
 * Strip adversary gate tags when a task reaches a terminal state.
 * This is the primary defense against stale adversary replay: once a task
 * is done/backlogged, no adversary review should be pending or recorded.
 */
function stripAdversaryGateTagsOnTerminal(
  status: string,
  tags: string[],
): string[] {
  if (!TERMINAL_TASK_STATUSES.has(status)) return tags;

  return tags.filter(
    (tag) =>
      !ADVERSARY_GATE_TAGS.some(
        (gateTag) => tag.trim().toLowerCase() === gateTag.toLowerCase(),
      ),
  );
}

export { stripAdversaryGateTagsOnTerminal, ADVERSARY_GATE_TAGS, TERMINAL_TASK_STATUSES };

// ─── Integration point in updateTask ────────────────────────────────────────
//
// In the updateTask function, after:
//   const mergedTags = normalizeTaskTags(updates.tags ?? existingTask.tags);
//
// Add:
//   const effectiveStatus = updates.status ?? existingTask.status;
//   const cleanedTags = stripAdversaryGateTagsOnTerminal(effectiveStatus, mergedTags);
//
// Then use `cleanedTags` instead of `mergedTags` in the SQL UPDATE.
