import assert from "node:assert/strict";
import test from "node:test";
import { log, reportError } from "./log";

test("log emits JSON lines without crashing and redacts secrets", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value: string) => {
    lines.push(value);
  };
  try {
    log.info("hello", { password: "secret", token: "abc", ok: true });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.password, "[redacted]");
  assert.equal(parsed.token, "[redacted]");
  assert.equal(parsed.ok, true);
});

test("reportError logs and does not throw when Sentry is unset", async () => {
  delete process.env.SENTRY_DSN;
  await reportError(new Error("boom"), { component: "test" });
});
