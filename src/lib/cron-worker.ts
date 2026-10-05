import { getDeadline } from "@vercel/functions";
import { runWorkerCycle } from "./worker-cycle";

/** Default batch size matches the local forever-worker (`scripts/worker.ts`). */
export const DEFAULT_BATCH_SIZE = 5;

/** Cap how many cycles one serverless invocation may run. */
export const DEFAULT_MAX_CYCLES = 20;

/**
 * Soft wall-clock budget when Vercel does not expose a deadline (local / tests).
 * Leave headroom under Hobby's ~60s function limit.
 */
export const DEFAULT_TIME_BUDGET_MS = 15_000;

/** Reserve this much time before the platform deadline to finish the response. */
const DEADLINE_SAFETY_MS = 2_000;

export type CronStopReason = "idle" | "max_cycles" | "time_budget";

export type CronWorkerResult = {
  ok: true;
  cycles: number;
  work: number;
  stoppedReason: CronStopReason;
};

export type CronWorkerOptions = {
  /** Injected for tests. Defaults to `runWorkerCycle`. */
  runCycle?: (limit: number) => Promise<number>;
  batchSize?: number;
  maxCycles?: number;
  /** Override the computed wall-clock budget (ms). */
  timeBudgetMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
};

/**
 * True when the request carries `Authorization: Bearer ${CRON_SECRET}`.
 * Rejects when CRON_SECRET is unset so an unprotected route never runs work.
 */
export function authorizeCronRequest(request: { headers: Headers }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

/** Prefer Vercel's invocation deadline when present; otherwise the soft default. */
export function resolveTimeBudgetMs(now = Date.now(), override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  const deadline = getDeadline();
  if (deadline) {
    return Math.max(0, deadline.getTime() - now - DEADLINE_SAFETY_MS);
  }
  const fromEnv = Number(process.env.CRON_TIME_BUDGET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIME_BUDGET_MS;
}

/**
 * Run one or more `runWorkerCycle` batches until the queue is idle, the cycle
 * cap is hit, or the time budget is exhausted. Each cycle already claims work
 * in a transaction, so overlapping invocations stay safe.
 */
export async function runCronWorker(options: CronWorkerOptions = {}): Promise<CronWorkerResult> {
  const runCycle = options.runCycle ?? runWorkerCycle;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES;
  const now = options.now ?? Date.now;
  const started = now();
  const budgetMs = resolveTimeBudgetMs(started, options.timeBudgetMs);

  let cycles = 0;
  let work = 0;
  let stoppedReason: CronStopReason = "idle";

  while (cycles < maxCycles) {
    if (now() - started >= budgetMs) {
      stoppedReason = "time_budget";
      break;
    }
    const done = await runCycle(batchSize);
    cycles += 1;
    work += done;
    if (done === 0) {
      stoppedReason = "idle";
      break;
    }
    if (cycles >= maxCycles) {
      stoppedReason = "max_cycles";
      break;
    }
    if (now() - started >= budgetMs) {
      stoppedReason = "time_budget";
      break;
    }
  }

  return { ok: true, cycles, work, stoppedReason };
}
