import { describe, it, expect, beforeEach } from "vitest";
import { AdversaryGateGuard } from "./guard.js";
import { InMemoryTaskStore, InMemoryEventLedger } from "./stores.js";
import type { AdversaryGateEvent, TaskSnapshot } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────

function makeTask(overrides?: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: "task-001",
    status: "in_progress",
    version: 1,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<AdversaryGateEvent>): AdversaryGateEvent {
  return {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: "task-001",
    action: "challenge",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Test Suite ─────────────────────────────────────────────────

describe("AdversaryGateGuard", () => {
  let store: InMemoryTaskStore;
  let ledger: InMemoryEventLedger;
  let guard: AdversaryGateGuard;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    ledger = new InMemoryEventLedger();
    guard = new AdversaryGateGuard(store, ledger, { logSuppressed: false });
  });

  // ────────────────────────────────────────────────────────────
  // 1. Terminal-state transition guard
  // ────────────────────────────────────────────────────────────

  describe("Terminal-state transition guard", () => {
    it("suppresses adversary gate event when task is in 'done' state", async () => {
      // Arrange: task already done
      store.seed(makeTask({ status: "done", version: 5 }));
      const event = makeEvent({ action: "challenge" });

      // Act
      const result = await guard.processEvent(event);

      // Assert
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("terminal state");
      expect(result.reason).toContain("done");

      // Task must still be in done state
      const task = store.peek("task-001");
      expect(task?.status).toBe("done");
      expect(task?.version).toBe(5); // unchanged
    });

    it("suppresses all adversary action types on terminal tasks", async () => {
      const actions = ["challenge", "reject", "request_changes", "block"] as const;

      for (const action of actions) {
        const freshStore = new InMemoryTaskStore();
        const freshLedger = new InMemoryEventLedger();
        const freshGuard = new AdversaryGateGuard(freshStore, freshLedger, {
          logSuppressed: false,
        });

        freshStore.seed(makeTask({ status: "done", version: 10 }));
        const event = makeEvent({ action, eventId: `evt-${action}` });

        const result = await freshGuard.processEvent(event);
        expect(result.applied).toBe(false);
        expect(result.reason).toContain("terminal state");

        const task = freshStore.peek("task-001");
        expect(task?.status).toBe("done");
      }
    });

    it("allows adversary gate event when task is NOT in terminal state", async () => {
      store.seed(makeTask({ status: "in_progress", version: 1 }));
      const event = makeEvent({ action: "challenge" });

      const result = await guard.processEvent(event);

      expect(result.applied).toBe(true);
      expect(result.reason).toBeUndefined();

      // Task should have been moved to review
      const task = store.peek("task-001");
      expect(task?.status).toBe("review");
      expect(task?.version).toBe(2);
    });

    it("allows adversary event on 'review' status task", async () => {
      store.seed(makeTask({ status: "review", version: 3 }));
      const event = makeEvent({ action: "request_changes" });

      const result = await guard.processEvent(event);

      expect(result.applied).toBe(true);
      const task = store.peek("task-001");
      expect(task?.status).toBe("needs_clarification");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 2. Consumer idempotency guard
  // ────────────────────────────────────────────────────────────

  describe("Consumer idempotency guard", () => {
    it("processes the same event only once; second delivery is a no-op", async () => {
      store.seed(makeTask({ status: "in_progress", version: 1 }));
      const event = makeEvent({ eventId: "evt-unique-123" });

      // First delivery — should apply
      const first = await guard.processEvent(event);
      expect(first.applied).toBe(true);

      const taskAfterFirst = store.peek("task-001");
      expect(taskAfterFirst?.status).toBe("review");
      expect(taskAfterFirst?.version).toBe(2);

      // Second delivery of the SAME event — should be suppressed
      const second = await guard.processEvent(event);
      expect(second.applied).toBe(false);
      expect(second.reason).toContain("Duplicate event suppressed");
      expect(second.reason).toContain("evt-unique-123");

      // Task state unchanged from first application
      const taskAfterSecond = store.peek("task-001");
      expect(taskAfterSecond?.status).toBe("review");
      expect(taskAfterSecond?.version).toBe(2);
    });

    it("allows different events for the same task", async () => {
      store.seed(makeTask({ status: "in_progress", version: 1 }));

      const event1 = makeEvent({ eventId: "evt-aaa" });
      const result1 = await guard.processEvent(event1);
      expect(result1.applied).toBe(true);

      // Task is now in "review" with version 2
      const event2 = makeEvent({ eventId: "evt-bbb", action: "request_changes" });
      const result2 = await guard.processEvent(event2);
      expect(result2.applied).toBe(true);

      const task = store.peek("task-001");
      expect(task?.status).toBe("needs_clarification");
      expect(task?.version).toBe(3);
    });

    it("marks terminal-state suppressions in the ledger to prevent retries", async () => {
      store.seed(makeTask({ status: "done", version: 5 }));
      const event = makeEvent({ eventId: "evt-terminal-dedup" });

      // First attempt — suppressed by terminal guard
      const first = await guard.processEvent(event);
      expect(first.applied).toBe(false);
      expect(first.reason).toContain("terminal state");

      // Second attempt — now suppressed by idempotency guard (faster path)
      const second = await guard.processEvent(event);
      expect(second.applied).toBe(false);
      expect(second.reason).toContain("Duplicate event suppressed");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 3. Stale replay regression test (the key scenario)
  // ────────────────────────────────────────────────────────────

  describe("Stale replay regression test", () => {
    it("creates a task, moves it to done, then replays adversary gate event — replay is suppressed", async () => {
      // Step 1: Create a task in in_progress state
      const task = makeTask({
        id: "task-regression-001",
        status: "in_progress",
        version: 1,
      });
      store.seed(task);

      // Step 2: An adversary gate event is created while task is in_progress
      const staleEvent = makeEvent({
        eventId: "evt-stale-replay",
        taskId: "task-regression-001",
        action: "reject",
        createdAt: new Date().toISOString(),
      });

      // Step 3: Task advances to done (simulating normal completion flow)
      await store.updateTask("task-regression-001", {
        status: "done",
        version: 2,
      });

      // Verify task is done
      const doneTask = store.peek("task-regression-001");
      expect(doneTask?.status).toBe("done");
      expect(doneTask?.version).toBe(2);

      // Step 4: The stale adversary gate event is replayed (e.g., network
      // retry, queue redelivery, or manual replay)
      const result = await guard.processEvent(staleEvent);

      // Step 5: Assert the replay was suppressed
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("terminal state");
      expect(result.reason).toContain("done");
      expect(result.eventId).toBe("evt-stale-replay");
      expect(result.taskId).toBe("task-regression-001");

      // Step 6: Assert the task remains in done state — no regression
      const finalTask = store.peek("task-regression-001");
      expect(finalTask?.status).toBe("done");
      expect(finalTask?.version).toBe(2); // version unchanged
    });

    it("handles rapid sequence: in_progress → adversary event → done → replay", async () => {
      // Simulate race condition: adversary event arrives, task goes done,
      // then the event is replayed.
      store.seed(
        makeTask({
          id: "task-race",
          status: "in_progress",
          version: 1,
        })
      );

      // Adversary event processes successfully while task is in_progress
      const event = makeEvent({
        eventId: "evt-race-1",
        taskId: "task-race",
        action: "challenge",
      });
      const firstResult = await guard.processEvent(event);
      expect(firstResult.applied).toBe(true);

      // Task is now in "review" — developer fixes and moves to done
      await store.updateTask("task-race", { status: "done", version: 100 });

      // Now a DIFFERENT adversary event arrives for the same task
      const lateEvent = makeEvent({
        eventId: "evt-race-2",
        taskId: "task-race",
        action: "reject",
      });
      const lateResult = await guard.processEvent(lateEvent);

      expect(lateResult.applied).toBe(false);
      expect(lateResult.reason).toContain("terminal state");

      const finalTask = store.peek("task-race");
      expect(finalTask?.status).toBe("done");
    });

    it("handles multiple rapid replays of the same stale event", async () => {
      store.seed(
        makeTask({
          id: "task-multi-replay",
          status: "done",
          version: 10,
        })
      );

      const event = makeEvent({
        eventId: "evt-multi",
        taskId: "task-multi-replay",
        action: "block",
      });

      // Fire 10 rapid replays
      const results = await Promise.all(
        Array.from({ length: 10 }, () => guard.processEvent(event))
      );

      // All should be suppressed
      for (const result of results) {
        expect(result.applied).toBe(false);
      }

      // Task untouched
      const task = store.peek("task-multi-replay");
      expect(task?.status).toBe("done");
      expect(task?.version).toBe(10);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("suppresses event for a non-existent task", async () => {
      // No task seeded
      const event = makeEvent({ taskId: "task-ghost" });
      const result = await guard.processEvent(event);

      expect(result.applied).toBe(false);
      expect(result.reason).toContain("Task not found");
    });

    it("handles event with empty payload gracefully", async () => {
      store.seed(makeTask({ status: "in_progress", version: 1 }));
      const event = makeEvent({ payload: {} });

      const result = await guard.processEvent(event);
      expect(result.applied).toBe(true);
    });

    it("ledger eviction does not break idempotency for recent events", async () => {
      // Use a tiny ledger to trigger eviction
      const tinyLedger = new InMemoryEventLedger({ maxEntries: 5 });
      const tinyGuard = new AdversaryGateGuard(store, tinyLedger, {
        logSuppressed: false,
      });

      store.seed(makeTask({ status: "in_progress", version: 1 }));

      // Process 6 events to trigger eviction
      for (let i = 0; i < 6; i++) {
        store.seed(
          makeTask({
            id: `task-evict-${i}`,
            status: "in_progress",
            version: 1,
          })
        );
        await tinyGuard.processEvent(
          makeEvent({
            eventId: `evt-evict-${i}`,
            taskId: `task-evict-${i}`,
          })
        );
      }

      // The most recent event should still be in the ledger
      const recentResult = await tinyGuard.processEvent(
        makeEvent({ eventId: "evt-evict-5", taskId: "task-evict-5" })
      );
      expect(recentResult.applied).toBe(false);
      expect(recentResult.reason).toContain("Duplicate");
    });
  });
});
