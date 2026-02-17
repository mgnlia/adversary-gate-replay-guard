# Integration Guide

Apply these changes to `guzus/office` to suppress stale adversary gate replay.

## Patch 1: Terminal-state tag cleanup in `updateTask`

**File:** `packages/backend/src/db/repository/tasks.ts`

### Step 1: Add constants after existing adversary tag constants

```typescript
// After:
const ADVERSARY_PASS_TAG = "adversary:pass";
const ADVERSARY_PENDING_TAG = "adversary:pending";

// Add:
const ADVERSARY_GATE_TAGS = [ADVERSARY_PASS_TAG, ADVERSARY_PENDING_TAG] as const;
const TERMINAL_TASK_STATUSES = new Set<string>(["done", "backlog"]);
```

### Step 2: Add guard function (before `updateTask`)

```typescript
/**
 * Strip adversary gate tags when a task reaches a terminal state.
 * Prevents stale adversary replay after task state advances.
 */
function stripAdversaryGateTagsOnTerminal(status: string, tags: string[]): string[] {
  if (!TERMINAL_TASK_STATUSES.has(status)) return tags;
  return tags.filter(
    (tag) => !ADVERSARY_GATE_TAGS.some(
      (gateTag) => tag.trim().toLowerCase() === gateTag.toLowerCase()
    )
  );
}
```

### Step 3: Call guard in `updateTask` before SQL write

In the `updateTask` function, find where `tags_json` is set for the SQL UPDATE.
Before that line, add:

```typescript
// Determine the effective status after this update
const effectiveStatus = (updates.status ?? existing.status) as string;
// Strip adversary gate tags on terminal transitions
const cleanedTags = stripAdversaryGateTagsOnTerminal(effectiveStatus, mergedTags);
// Use cleanedTags instead of mergedTags in the SQL UPDATE for tags_json
```

---

## Patch 2: Idempotency guard in adversary review queue

**File:** `packages/backend/src/scheduler/jobs.ts`

### Step 1: Add module-level tracking set

```typescript
// After existing constants, add:
const adversaryInFlightTaskIds = new Set<string>();
const adversaryInFlightTimestamps = new Map<string, number>();
const ADVERSARY_INFLIGHT_STALE_MS = 10 * 60_000;
```

### Step 2: Modify `autopilotNudgeAdversaryReviewQueue`

In the `for (const task of gated)` loop, add these guards:

```typescript
for (const task of gated) {
  const tags = normalizeTaskTags(task.tags || []);
  const hasPass = hasTaskTag(tags, ADVERSARY_REVIEW_PASS_TAG);
  const hasPending = hasTaskTag(tags, ADVERSARY_REVIEW_PENDING_TAG);

  // --- NEW: Skip if already in-flight (idempotency guard) ---
  if (adversaryInFlightTaskIds.has(task.id)) continue;

  if (hasPass && hasPending) {
    const cleaned = removeTaskTag(tags, ADVERSARY_REVIEW_PENDING_TAG);
    const updated = await repo.updateTask(task.id, { tags: cleaned });
    if (updated) emitTaskUpdated(updated);
    continue;
  }

  if (hasPass || hasPending) continue;

  // --- NEW: Re-verify task is still in review (race guard) ---
  const freshTask = await repo.getTask(task.id);
  if (!freshTask || freshTask.status !== "review") continue;

  const withPending = addTaskTag(tags, ADVERSARY_REVIEW_PENDING_TAG);
  const updated = await repo.updateTask(task.id, { tags: withPending });
  if (updated) {
    emitTaskUpdated(updated);
    newlyQueued.push(updated);
    // --- NEW: Mark as in-flight ---
    adversaryInFlightTaskIds.add(task.id);
    adversaryInFlightTimestamps.set(task.id, Date.now());
  }
}
```

### Step 3: Add periodic cleanup

In `startScheduler`, add a cleanup call at the start of each adversary tick:

```typescript
// At the top of autopilotNudgeAdversaryReviewQueue:
const cutoff = Date.now() - ADVERSARY_INFLIGHT_STALE_MS;
for (const [taskId, ts] of adversaryInFlightTimestamps) {
  if (ts < cutoff) {
    adversaryInFlightTaskIds.delete(taskId);
    adversaryInFlightTimestamps.delete(taskId);
  }
}
```

### Step 4: Clear in-flight on verdict

When the adversary processes a verdict (in the adversary's tag update logic),
the terminal-state guard in Patch 1 handles `done` transitions automatically.
For `in_progress` (FAIL) transitions, the `adversary:pending` tag removal by
the adversary agent will naturally prevent re-queue on the next tick since
`hasPending` will be false and `adversaryInFlightTaskIds` prevents duplicates.

---

## Verification

Run the regression test:

```bash
cd adversary-gate-replay-guard
bun test
```

All 12 test cases should pass, covering:
- Terminal-state tag stripping (7 cases)
- In-flight idempotency (4 cases)  
- Integration scenario (3 cases)
