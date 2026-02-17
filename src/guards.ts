/**
 * Adversary gate replay guards.
 *
 * These functions are designed to be dropped into the office backend
 * repository layer (tasks.ts) and scheduler (jobs.ts) to prevent
 * stale adversary gate events from regressing task state.
 */

// ── Constants ────────────────────────────────────────────────

export const ADVERSARY_PASS_TAG = "adversary:pass";
export const ADVERSARY_PENDING_TAG = "adversary:pending";

/** States from which no adversary-driven regression should occur. */
export const TERMINAL_STATES = new Set(["done"]);

/** States that the adversary gate is allowed to operate on. */
export const ADVERSARY_GATE_ELIGIBLE_STATES = new Set(["review"]);

// ── Tag helpers ──────────────────────────────────────────────

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function hasTag(tags: string[], expected: string): boolean {
  const needle = normalizeTag(expected);
  return tags.some((tag) => normalizeTag(tag) === needle);
}

export function isAdversaryTag(tag: string): boolean {
  const normalized = normalizeTag(tag);
  return (
    normalized === normalizeTag(ADVERSARY_PASS_TAG) ||
    normalized === normalizeTag(ADVERSARY_PENDING_TAG)
  );
}

export function hasAnyAdversaryTag(tags: string[]): boolean {
  return tags.some(isAdversaryTag);
}

export function removeTag(tags: string[], target: string): string[] {
  const needle = normalizeTag(target);
  return tags.filter((tag) => normalizeTag(tag) !== needle);
}

// ── Guard 1: Terminal-state transition guard ─────────────────

export interface TaskStateGuardInput {
  currentStatus: string;
  currentTags: string[];
  requestedStatus?: string;
  requestedTags?: string[];
}

export interface TaskStateGuardResult {
  blocked: boolean;
  reason?: string;
  /** If not blocked, cleaned tags with stale adversary tags removed. */
  cleanedTags?: string[];
}

/**
 * Checks whether an updateTask call should be blocked because it would
 * regress a terminal-state task via adversary gate replay.
 *
 * Returns { blocked: true, reason } if the update should be rejected,
 * or { blocked: false, cleanedTags } with any stale adversary tags stripped.
 */
export function checkTerminalStateGuard(
  input: TaskStateGuardInput
): TaskStateGuardResult {
  const { currentStatus, currentTags, requestedStatus, requestedTags } = input;

  // Only guard terminal states
  if (!TERMINAL_STATES.has(currentStatus)) {
    return { blocked: false };
  }

  // If the update is trying to change status away from terminal AND includes
  // adversary tags, this is a stale replay — block it.
  if (requestedStatus && requestedStatus !== currentStatus) {
    const incomingTags = requestedTags ?? currentTags;
    if (hasAnyAdversaryTag(incomingTags)) {
      return {
        blocked: true,
        reason:
          `Blocked: cannot regress task from '${currentStatus}' to '${requestedStatus}' ` +
          `via adversary gate — task has already reached terminal state.`,
      };
    }
  }

  // If the update is only adding adversary tags to a terminal task (no status change),
  // strip the adversary tags silently instead of blocking.
  if (requestedTags && hasAnyAdversaryTag(requestedTags)) {
    const cleanedTags = requestedTags.filter((tag) => !isAdversaryTag(tag));
    return { blocked: false, cleanedTags };
  }

  return { blocked: false };
}

// ── Guard 2: Consumer idempotency (scheduler side) ───────────

export interface AdversaryQueueCandidate {
  id: string;
  status: string;
  tags: string[];
  priority: string;
}

export interface AdversaryQueueFilterResult {
  eligible: AdversaryQueueCandidate[];
  staleCleanup: Array<{ id: string; cleanedTags: string[] }>;
  skippedReasons: Map<string, string>;
}

/**
 * Filters a list of tasks to determine which are actually eligible for
 * adversary gate review. Returns eligible tasks, tasks needing stale
 * tag cleanup, and reasons for skipping.
 */
export function filterAdversaryQueueCandidates(
  tasks: AdversaryQueueCandidate[]
): AdversaryQueueFilterResult {
  const eligible: AdversaryQueueCandidate[] = [];
  const staleCleanup: Array<{ id: string; cleanedTags: string[] }> = [];
  const skippedReasons = new Map<string, string>();

  for (const task of tasks) {
    const tags = task.tags;

    // Skip: task is no longer in a state eligible for adversary review
    if (!ADVERSARY_GATE_ELIGIBLE_STATES.has(task.status)) {
      // If it still has adversary:pending tag, schedule cleanup
      if (hasTag(tags, ADVERSARY_PENDING_TAG)) {
        staleCleanup.push({
          id: task.id,
          cleanedTags: removeTag(tags, ADVERSARY_PENDING_TAG),
        });
      }
      skippedReasons.set(
        task.id,
        `Skipped: status '${task.status}' is not eligible for adversary review`
      );
      continue;
    }

    // Skip: already passed adversary review (idempotency)
    if (hasTag(tags, ADVERSARY_PASS_TAG)) {
      // Clean up pending tag if both are present
      if (hasTag(tags, ADVERSARY_PENDING_TAG)) {
        staleCleanup.push({
          id: task.id,
          cleanedTags: removeTag(tags, ADVERSARY_PENDING_TAG),
        });
      }
      skippedReasons.set(task.id, "Skipped: already has adversary:pass tag");
      continue;
    }

    // Skip: already pending (don't double-queue)
    if (hasTag(tags, ADVERSARY_PENDING_TAG)) {
      skippedReasons.set(task.id, "Skipped: already has adversary:pending tag");
      continue;
    }

    // Only high/critical tasks require adversary review
    if (task.priority !== "high" && task.priority !== "critical") {
      skippedReasons.set(
        task.id,
        `Skipped: priority '${task.priority}' does not require adversary review`
      );
      continue;
    }

    eligible.push(task);
  }

  return { eligible, staleCleanup, skippedReasons };
}

// ── Guard 3: Adversary verdict application guard ─────────────

export interface AdversaryVerdictInput {
  taskId: string;
  currentStatus: string;
  currentTags: string[];
  verdict: "pass" | "fail";
}

export interface AdversaryVerdictResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Checks whether an adversary verdict (pass/fail) should be applied
 * to a task given its current state.
 */
export function checkAdversaryVerdictApplicable(
  input: AdversaryVerdictInput
): AdversaryVerdictResult {
  const { currentStatus, currentTags, verdict } = input;

  // Cannot apply verdict to terminal-state tasks
  if (TERMINAL_STATES.has(currentStatus)) {
    return {
      allowed: false,
      reason: `Cannot apply adversary ${verdict} verdict: task is in terminal state '${currentStatus}'.`,
    };
  }

  // Cannot apply verdict to tasks not in review (they've moved on)
  if (!ADVERSARY_GATE_ELIGIBLE_STATES.has(currentStatus)) {
    return {
      allowed: false,
      reason:
        `Cannot apply adversary ${verdict} verdict: task status is '${currentStatus}', ` +
        `expected one of: ${[...ADVERSARY_GATE_ELIGIBLE_STATES].join(", ")}.`,
    };
  }

  // Idempotency: if already passed, don't re-process
  if (verdict === "pass" && hasTag(currentTags, ADVERSARY_PASS_TAG)) {
    return {
      allowed: false,
      reason: "Adversary pass verdict already applied (idempotent skip).",
    };
  }

  return { allowed: true };
}
