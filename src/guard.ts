import type {
  AdversaryGateEvent,
  EventLedger,
  EventProcessingResult,
  TaskStore,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";

/**
 * Configuration for the AdversaryGateGuard.
 */
export interface GuardConfig {
  /**
   * When true, log suppressed events to console for observability.
   * Default: true
   */
  logSuppressed?: boolean;
}

/**
 * AdversaryGateGuard — the core reliability layer that prevents stale
 * adversary gate replays from mutating tasks that have already reached
 * a terminal state.
 *
 * It enforces two invariants:
 *
 * 1. **Terminal-state transition guard**: If a task is in a terminal state
 *    (done, canceled), adversary gate events targeting it are suppressed.
 *
 * 2. **Consumer idempotency guard**: If the same event (by eventId) has
 *    already been processed, subsequent deliveries are no-ops.
 */
export class AdversaryGateGuard {
  private readonly taskStore: TaskStore;
  private readonly eventLedger: EventLedger;
  private readonly config: Required<GuardConfig>;

  constructor(
    taskStore: TaskStore,
    eventLedger: EventLedger,
    config?: GuardConfig
  ) {
    this.taskStore = taskStore;
    this.eventLedger = eventLedger;
    this.config = {
      logSuppressed: config?.logSuppressed ?? true,
    };
  }

  /**
   * Process an adversary gate event with full guard checks.
   *
   * Returns an EventProcessingResult indicating whether the event was
   * applied or suppressed (and why).
   */
  async processEvent(
    event: AdversaryGateEvent
  ): Promise<EventProcessingResult> {
    const { eventId, taskId } = event;

    // ── Guard 1: Idempotency check ─────────────────────────
    const alreadyProcessed = await this.eventLedger.hasProcessed(eventId);
    if (alreadyProcessed) {
      const result: EventProcessingResult = {
        applied: false,
        reason: `Duplicate event suppressed: eventId=${eventId} was already processed`,
        eventId,
        taskId,
      };
      if (this.config.logSuppressed) {
        console.log(
          `[AdversaryGateGuard] SUPPRESSED (idempotency): ${result.reason}`
        );
      }
      return result;
    }

    // ── Guard 2: Terminal-state check ──────────────────────
    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      const result: EventProcessingResult = {
        applied: false,
        reason: `Task not found: taskId=${taskId}`,
        eventId,
        taskId,
      };
      if (this.config.logSuppressed) {
        console.log(
          `[AdversaryGateGuard] SUPPRESSED (not found): ${result.reason}`
        );
      }
      // Still mark as processed to prevent retries on a deleted task.
      await this.eventLedger.markProcessed(eventId);
      return result;
    }

    if (TERMINAL_STATES.has(task.status)) {
      const result: EventProcessingResult = {
        applied: false,
        reason: `Task ${taskId} is in terminal state '${task.status}'; adversary gate event ${eventId} (action=${event.action}) suppressed`,
        eventId,
        taskId,
      };
      if (this.config.logSuppressed) {
        console.log(
          `[AdversaryGateGuard] SUPPRESSED (terminal state): ${result.reason}`
        );
      }
      // Mark as processed so replays of this exact event are also caught
      // by the idempotency guard.
      await this.eventLedger.markProcessed(eventId);
      return result;
    }

    // ── Apply the event ────────────────────────────────────
    // In the real system this would dispatch to the adversary agent's
    // handler. Here we model the state mutation that an adversary gate
    // event would cause (e.g., moving the task back to review/needs_clarification).
    const applied = await this.applyAdversaryAction(event, task.version);

    // Mark as processed regardless of apply outcome.
    await this.eventLedger.markProcessed(eventId);

    if (!applied) {
      return {
        applied: false,
        reason: `Optimistic concurrency conflict: task ${taskId} version changed during apply`,
        eventId,
        taskId,
      };
    }

    return {
      applied: true,
      eventId,
      taskId,
    };
  }

  /**
   * Apply the adversary gate action to the task.
   * Uses optimistic concurrency via version check.
   */
  private async applyAdversaryAction(
    event: AdversaryGateEvent,
    expectedVersion: number
  ): Promise<boolean> {
    const targetStatus = this.resolveTargetStatus(event.action);

    // Re-read to verify version hasn't changed (optimistic lock).
    const current = await this.taskStore.getTask(event.taskId);
    if (!current || current.version !== expectedVersion) {
      return false;
    }

    // Double-check terminal state (race condition guard).
    if (TERMINAL_STATES.has(current.status)) {
      return false;
    }

    const updated = await this.taskStore.updateTask(event.taskId, {
      status: targetStatus,
      version: expectedVersion + 1,
    });

    return updated !== null;
  }

  /**
   * Map adversary gate actions to the task status they would impose.
   */
  private resolveTargetStatus(
    action: AdversaryGateEvent["action"]
  ): "review" | "needs_clarification" {
    switch (action) {
      case "challenge":
      case "reject":
        return "review";
      case "request_changes":
      case "block":
        return "needs_clarification";
      default:
        return "review";
    }
  }
}
