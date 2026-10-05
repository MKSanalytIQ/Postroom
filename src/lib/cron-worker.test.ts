import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCronRequest,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_CYCLES,
  resolveTimeBudgetMs,
  runCronWorker,
} from "./cron-worker";

test("authorizeCronRequest requires CRON_SECRET and a matching Bearer token", () => {
  const prev = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal(authorizeCronRequest({ headers: new Headers({ authorization: "Bearer x" }) }), false);

    process.env.CRON_SECRET = "test-cron-secret";
    assert.equal(authorizeCronRequest({ headers: new Headers() }), false);
    assert.equal(authorizeCronRequest({ headers: new Headers({ authorization: "Bearer wrong" }) }), false);
    assert.equal(authorizeCronRequest({ headers: new Headers({ authorization: "Bearer test-cron-secret" }) }), true);
    assert.equal(authorizeCronRequest({ headers: new Headers({ authorization: "bearer test-cron-secret" }) }), false);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("resolveTimeBudgetMs uses an explicit override", () => {
  assert.equal(resolveTimeBudgetMs(1_000, 5_000), 5_000);
  assert.equal(resolveTimeBudgetMs(1_000, 0), 0);
});

test("runCronWorker stops when a cycle reports no work", async () => {
  const calls: number[] = [];
  const result = await runCronWorker({
    batchSize: 3,
    maxCycles: 10,
    timeBudgetMs: 60_000,
    runCycle: async (limit) => {
      calls.push(limit);
      return 0;
    },
  });
  assert.deepEqual(calls, [3]);
  assert.deepEqual(result, { ok: true, cycles: 1, work: 0, stoppedReason: "idle" });
});

test("runCronWorker stops at maxCycles while work remains", async () => {
  let n = 0;
  const result = await runCronWorker({
    batchSize: DEFAULT_BATCH_SIZE,
    maxCycles: 3,
    timeBudgetMs: 60_000,
    runCycle: async () => {
      n += 1;
      return 2;
    },
  });
  assert.equal(n, 3);
  assert.deepEqual(result, { ok: true, cycles: 3, work: 6, stoppedReason: "max_cycles" });
});

test("runCronWorker stops when the time budget is exhausted", async () => {
  let clock = 0;
  const calls: number[] = [];
  const result = await runCronWorker({
    maxCycles: DEFAULT_MAX_CYCLES,
    timeBudgetMs: 100,
    now: () => clock,
    runCycle: async () => {
      calls.push(clock);
      clock += 60;
      return 1;
    },
  });
  assert.ok(calls.length >= 1);
  assert.ok(calls.length <= 3, `expected few cycles under a tight budget, got ${calls.length}`);
  assert.equal(result.stoppedReason, "time_budget");
  assert.equal(result.ok, true);
  assert.equal(result.work, calls.length);
  assert.equal(result.cycles, calls.length);
});

test("runCronWorker accumulates work across cycles until idle", async () => {
  const queue = [4, 2, 0];
  const result = await runCronWorker({
    timeBudgetMs: 60_000,
    maxCycles: 10,
    runCycle: async () => queue.shift() ?? 0,
  });
  assert.deepEqual(result, { ok: true, cycles: 3, work: 6, stoppedReason: "idle" });
});
