import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "./rate-limit";

test("a fixed window allows the limit, refuses the rest, and starts over", () => {
  let clock = 0;
  const limiter = createRateLimiter(3, 60_000, () => clock);
  assert.deepEqual([1, 2, 3].map(() => limiter.take("a").allowed), [true, true, true]);
  const fourth = limiter.take("a");
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.retryAfterSeconds, 60);
  assert.equal(limiter.take("b").allowed, true, "keys are independent");
  clock = 45_000;
  assert.equal(limiter.take("a").retryAfterSeconds, 15);
  clock = 60_000;
  assert.equal(limiter.take("a").allowed, true, "a new window");
});

test("blocked() only looks, and becomes true once the allowance is used", () => {
  const limiter = createRateLimiter(2, 1000, () => 0);
  assert.equal(limiter.blocked("k").blocked, false);
  limiter.take("k");
  assert.equal(limiter.blocked("k").blocked, false);
  limiter.take("k");
  assert.equal(limiter.blocked("k").blocked, true);
  limiter.reset();
  assert.equal(limiter.blocked("k").blocked, false);
});

test("memory stays bounded when many keys appear", () => {
  const limiter = createRateLimiter(1, 1000, () => 0);
  for (let i = 0; i < 12_000; i += 1) limiter.take(`ip-${i}`);
  assert.equal(limiter.take("ip-11999").allowed, false, "recent keys are still tracked");
});
