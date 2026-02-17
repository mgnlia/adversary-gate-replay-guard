import type { TaskSnapshot, TaskStore, EventLedger } from "./types.js";

/**
 * In-memory task store — suitable for tests and single-process deployments.
 * For production, swap in a Postgres-backed implementation.
 */
export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskSnapshot>();

  /** Seed a task into the store (test helper). */
  seed(task: TaskSnapshot): void {
    this.tasks.set(task.id, { ...task });
  }

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(
    taskId: string,
    update: Partial<Pick<TaskSnapshot, "status" | "version">>,
  ): Promise<TaskSnapshot | null> {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;

    const updated: TaskSnapshot = {
      ...existing,
      status: update.status ?? existing.status,
      version: update.version ?? existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  /** Expose snapshot for assertions (test helper). */
  peek(taskId: string): TaskSnapshot | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : undefined;
  }
}

/**
 * In-memory event ledger — tracks which event IDs have been processed.
 * Uses a Map with LRU-style eviction for long-running processes.
 */
export class InMemoryEventLedger implements EventLedger {
  private processed = new Map<string, number>(); // eventId → timestamp
  private readonly maxEntries: number;

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? 100_000;
  }

  async hasProcessed(eventId: string): Promise<boolean> {
    return this.processed.has(eventId);
  }

  async markProcessed(eventId: string): Promise<void> {
    // Evict oldest entries if we're at capacity.
    if (this.processed.size >= this.maxEntries) {
      const cutoff = Math.ceil(this.maxEntries * 0.1); // evict 10%
      let removed = 0;
      for (const [key] of this.processed) {
        if (removed >= cutoff) break;
        this.processed.delete(key);
        removed++;
      }
    }
    this.processed.set(eventId, Date.now());
  }

  /** For testing: check the ledger size. */
  get size(): number {
    return this.processed.size;
  }
}
