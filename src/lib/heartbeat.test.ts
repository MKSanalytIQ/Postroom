import assert from "node:assert/strict";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { latestWorkerHeartbeat, touchWorkerHeartbeat } from "./heartbeat";
import { closeSql } from "./sql";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";

test("worker heartbeat is stored and readable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  await closeSql();
  try {
    await touchWorkerHeartbeat("idle", "test-worker");
    const beat = await latestWorkerHeartbeat();
    assert.equal(beat?.workerId, "test-worker");
    assert.equal(beat?.stale, false);
    assert.equal(beat?.detail, "idle");
  } finally {
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
