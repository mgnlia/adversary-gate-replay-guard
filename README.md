# @ai-office/adversary-gate-replay-guard

> Reliability fix: suppress stale adversary gate replay after task state advances to terminal states.

## Problem

When an adversary gate event is queued while a task is in `in_progress` or `review`, but the task advances to `done` before the event is processed (or the event is replayed due to network retries/queue redelivery), the stale event can incorrectly mutate the task back to a non-terminal state — causing data corruption and zombie task loops.

## Solution

Two guard layers are enforced at the event processing boundary:

### 1. Terminal-State Transition Guard

Before applying any adversary gate event, the guard checks the current task status. If the task has reached a terminal state (`done`), the event is suppressed and logged.

```
Event arrives → Read task state → Terminal? → SUPPRESS (no-op)
                                → Active?   → APPLY
```

### 2. Consumer Idempotency Guard

Every adversary gate event carries a unique `eventId`. The guard maintains a ledger of processed event IDs. Duplicate deliveries (same `eventId`) are detected and suppressed before any state mutation.

```
Event arrives → Already processed? → SUPPRESS (no-op)
             → New event?          → Check terminal guard → Process
```

## Architecture

```
src/
├── types.ts       # Core types: TaskSnapshot, AdversaryGateEvent, interfaces
├── guard.ts       # AdversaryGateGuard — the main reliability layer
├── stores.ts      # In-memory implementations of TaskStore and EventLedger
├── index.ts       # Public API exports
└── guard.test.ts  # Comprehensive regression tests
```

## Usage

```typescript
import {
  AdversaryGateGuard,
  InMemoryTaskStore,
  InMemoryEventLedger,
} from "@ai-office/adversary-gate-replay-guard";

const taskStore = new InMemoryTaskStore();
const eventLedger = new InMemoryEventLedger();
const guard = new AdversaryGateGuard(taskStore, eventLedger);

// Process an event — returns { applied: boolean, reason?: string }
const result = await guard.processEvent({
  eventId: "evt-abc-123",
  taskId: "task-001",
  action: "challenge",
  createdAt: new Date().toISOString(),
});

if (!result.applied) {
  console.log(`Event suppressed: ${result.reason}`);
}
```

## Integration with AI Office

To integrate with the existing `packages/backend` event processing:

1. Instantiate `AdversaryGateGuard` with a Postgres-backed `TaskStore` (wrapping the existing `repository/tasks.ts`)
2. Replace direct adversary event handling with `guard.processEvent(event)`
3. The guard will automatically suppress stale replays and duplicates

## Running Tests

```bash
npm install
npm test
```

## Test Coverage

- ✅ Terminal-state suppression for all adversary actions (challenge, reject, request_changes, block)
- ✅ Idempotency — duplicate event deliveries are no-ops
- ✅ **Stale replay regression**: task created → moved to done → adversary event replayed → suppressed
- ✅ Race condition: rapid sequence of events with interleaved state changes
- ✅ Multiple concurrent replays of the same stale event
- ✅ Non-existent task handling
- ✅ Ledger eviction behavior
