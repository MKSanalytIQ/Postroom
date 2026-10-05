import assert from "node:assert/strict";
import test from "node:test";
import { classifyTracking, SCANNER_IMMEDIATE_SECONDS } from "./scanner";

test("scanner heuristics flag bots, HEAD, too-soon, and multi-link", () => {
  const prev = process.env.POSTROOM_SCANNER_IMMEDIATE_SECONDS;
  delete process.env.POSTROOM_SCANNER_IMMEDIATE_SECONDS;
  assert.equal(classifyTracking({ userAgent: "Proofpoint URL Defense" }).bot, true);
  assert.equal(classifyTracking({ method: "HEAD" }).bot, true);
  const sentAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(classifyTracking({ sentAt }).bot, true);
  assert.equal(classifyTracking({ sentAt, now: new Date(Date.parse(sentAt) + (SCANNER_IMMEDIATE_SECONDS + 1) * 1000) }).bot, false);
  assert.equal(
    classifyTracking({ url: "https://a.example/x", recentClickUrls: ["https://a.example/y"] }).bot,
    true,
  );
  assert.equal(classifyTracking({ userAgent: "Mozilla/5.0", method: "GET" }).bot, false);
  if (prev === undefined) delete process.env.POSTROOM_SCANNER_IMMEDIATE_SECONDS;
  else process.env.POSTROOM_SCANNER_IMMEDIATE_SECONDS = prev;
});
