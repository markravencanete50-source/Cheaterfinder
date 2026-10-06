import { AsyncLocalStorage } from "node:async_hooks";
const signals = new AsyncLocalStorage<AbortSignal>();
export function operationSignal(): AbortSignal | undefined { return signals.getStore(); }
export function withOperationSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return signals.run(signal, work);
}
