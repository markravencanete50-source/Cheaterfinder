import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface ScrapeOperation {
  id: string;
  attempts: number;
  maxAttempts: number;
  viewerBotId?: string;
  transport?: string;
}
const operations = new AsyncLocalStorage<ScrapeOperation>();
export class ScrapeAttemptBudgetError extends Error {
  constructor() { super("shared scrape attempt budget exhausted"); this.name = "ScrapeAttemptBudgetError"; }
}
export function currentScrapeOperation(): ScrapeOperation | undefined { return operations.getStore(); }
export function consumeScrapeAttempt(): void {
  const op = operations.getStore();
  if (!op) return;
  if (op.attempts >= op.maxAttempts) throw new ScrapeAttemptBudgetError();
  op.attempts += 1;
}
export function withScrapeOperation<T>(work: () => Promise<T>): Promise<T> {
  if (operations.getStore()) return work();
  const op: ScrapeOperation = { id: randomUUID(), attempts: 0, maxAttempts: 7 };
  return operations.run(op, work);
}
