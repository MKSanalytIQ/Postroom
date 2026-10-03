import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import {
  activateAutomation,
  addDelayStep,
  addEmailStep,
  advanceEnrollment,
  applyExitConditions,
  createAutomation,
  enrollmentCounts,
  getRules,
  listSteps,
  recentEnrollments,
  runAutomationCycle,
  saveRules,
  stepStats,
  type RulesInput,
} from "./automations";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  listTemplates,
  recordClick,
  recordOpen,
  updateSettings,
} from "./queries";
import { nextAllowedTime } from "./send-window";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

// Same approach as automations.test.ts: SQLite by default, Postgres when DATABASE_URL is set.

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";

const SETTINGS = {
  name: "Ada Lovelace",
  companyName: "Analytical Engines",
  postalAddress: "1 King Street\nLondon",
  fromName: "Ada",
  fromEmail: "owner@postroom.test",
  replyTo: "",
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "",
  smtpPass: null,
};

const NO_RULES: RulesInput = {
  exitOnClick: false,
  exitListId: null,
  windowEnabled: false,
  windowDays: [0, 1, 2, 3, 4, 5, 6],
  windowStartHour: 9,
  windowEndHour: 17,
  timezone: "UTC",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDatabase(fn: (ownerEmail: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  await closeSql();
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@postroom.test`;
  try {
    await fn(ownerEmail);
  } finally {
    const sql = await readySql();
    const owner = (await sql.prepare("SELECT id FROM users WHERE email = ?").get(ownerEmail)) as { id: string } | null;
    if (owner) {
      await sql.prepare("DELETE FROM suppressions WHERE user_id = ?").run(owner.id);
      await deleteAccount(owner.id);
    }
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function setup(ownerEmail: string, steps: ("email" | number)[], rules: Partial<RulesInput> = {}) {
  const user = await createUser({ name: "Ada Lovelace", email: ownerEmail, password: "password123" });
  await updateSettings(user.id, SETTINGS);
  const [template] = await listTemplates(user.id);
  const listId = await createList(user.id, "Welcome");
  const id = await createAutomation(user.id, { name: "Series", listId });
  for (const step of steps) {
    if (step === "email") await addEmailStep(user.id, id, template.id);
    else await addDelayStep(user.id, id, step, "hours");
  }
  await saveRules(user.id, id, { ...NO_RULES, ...rules });
  return { user, listId, id };
}

async function contactId(userId: string, email: string): Promise<string> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(userId, email)) as { id: string };
  return row.id;
}

async function tokenFor(email: string, position: number): Promise<string> {
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT r.token FROM recipients r
       JOIN automation_sends s ON s.recipient_id = r.id
       JOIN automation_steps st ON st.id = s.step_id
       WHERE r.email = ? AND st.position = ?`,
    )
    .get(email, position)) as { token: string } | null;
  assert.ok(row, `recipient for ${email} at step ${position}`);
  return row.token;
}

async function statusOf(automationId: string, email: string): Promise<{ status: string; reason: string }> {
  const row = (await recentEnrollments((await ownerOf(automationId)), automationId)).find((item) => item.email === email);
  assert.ok(row, `enrollment for ${email}`);
  return { status: row.status, reason: row.stopReason };
}

async function ownerOf(automationId: string): Promise<string> {
  const sql = await readySql();
  return ((await sql.prepare("SELECT user_id FROM automations WHERE id = ?").get(automationId)) as { user_id: string }).user_id;
}

async function fastForward(automationId: string): Promise<void> {
  const sql = await readySql();
  await sql
    .prepare("UPDATE automation_enrollments SET next_run_at = ? WHERE automation_id = ? AND status = 'active'")
    .run("2000-01-01T00:00:00.000Z", automationId);
}

async function count(query: string, ...params: unknown[]): Promise<number> {
  const sql = await readySql();
  return Number(((await sql.prepare(query).get(...params)) as { n: number | string }).n);
}

test("rules default to off and can be saved, validated, and changed while running", async () => {
  await withDatabase(async (ownerEmail) => {
    const { user, listId, id } = await setup(ownerEmail, ["email"]);
    const other = await createList(user.id, "Customers");
    const sql = await readySql();
    await sql.prepare("DELETE FROM automation_settings WHERE automation_id = ?").run(id);
    const defaults = await getRules(user.id, id);
    assert.equal(defaults.exitOnClick, false);
    assert.equal(defaults.exitListId, null);
    assert.equal(defaults.windowEnabled, false);
    assert.equal(defaults.timezone, "UTC");

    await assert.rejects(saveRules(user.id, id, { ...NO_RULES, exitListId: listId }), /different list/);
    await assert.rejects(saveRules(user.id, id, { ...NO_RULES, exitListId: "missing" }), /List not found/);
    await assert.rejects(saveRules(user.id, id, { ...NO_RULES, windowEnabled: true, windowDays: [] }), /at least one day/);
    await assert.rejects(saveRules(user.id, id, { ...NO_RULES, windowEnabled: true, windowStartHour: 18 }), /end after/);
    await assert.rejects(saveRules(user.id, id, { ...NO_RULES, windowEnabled: true, timezone: "Mars/Base" }), /timezone/);

    const input: RulesInput = {
      exitOnClick: true,
      exitListId: other,
      windowEnabled: true,
      windowDays: [5, 1, 3],
      windowStartHour: 8,
      windowEndHour: 12,
      timezone: "Asia/Kolkata",
    };
    await saveRules(user.id, id, input);
    await saveRules(user.id, id, input); // saving twice updates the same row
    assert.equal(await count("SELECT COUNT(*) AS n FROM automation_settings WHERE automation_id = ?", id), 1);
    assert.deepEqual(await getRules(user.id, id), {
      exitOnClick: true,
      exitListId: other,
      exitListName: "Customers",
      windowEnabled: true,
      windowDays: [1, 3, 5],
      windowStartHour: 8,
      windowEndHour: 12,
      timezone: "Asia/Kolkata",
    });

    // Rules stay editable on a running automation; a disabled window ignores junk values.
    await activateAutomation(user.id, id, "http://localhost:3010");
    await saveRules(user.id, id, { ...input, windowEnabled: false, windowDays: [], windowStartHour: 30, timezone: "Nope/Nope" });
    const relaxed = await getRules(user.id, id);
    assert.equal(relaxed.windowEnabled, false);
    assert.equal(relaxed.timezone, "UTC");
    assert.deepEqual(relaxed.windowDays, [0, 1, 2, 3, 4, 5, 6]);

    // Deleting the exit list switches that condition off instead of breaking the automation.
    await sql.prepare("DELETE FROM lists WHERE id = ?").run(other);
    assert.equal((await getRules(user.id, id)).exitListId, null);
  });
});

test("rules table is created on an existing database that predates it", async () => {
  await withDatabase(async (ownerEmail) => {
    const { user, listId, id } = await setup(ownerEmail, ["email"]);
    await activateAutomation(user.id, id, "http://localhost:3010");
    const sql = await readySql();
    await sql.prepare("DROP TABLE automation_settings").run();
    await closeSql(); // the next use re-runs the schema, as when an older install upgrades
    await addContact(user.id, { email: "late@example.com", firstName: "Late", lastName: "", listId });
    assert.equal(await count("SELECT COUNT(*) AS n FROM automation_settings"), 0);
    assert.equal((await getRules(user.id, id)).windowEnabled, false);
    assert.equal(await runAutomationCycle() > 0, true, "the automation still works with default rules");
    await runBatch(10);
    assert.equal((await enrollmentCounts(id)).emailsSent, 1);
  });
});

test("clicking a link stops the series only when that exit condition is on", async () => {
  await withDatabase(async (ownerEmail) => {
    const { user, listId, id } = await setup(ownerEmail, ["email", "email", "email"]);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "a@example.com", firstName: "A", lastName: "", listId });
    await addContact(user.id, { email: "b@example.com", firstName: "B", lastName: "", listId });
    await runAutomationCycle(); // email 1 queued for both
    await runBatch(10);

    // Exit on click is off: a click is only recorded.
    await recordClick(await tokenFor("b@example.com", 0), "https://example.com/x");
    assert.equal((await statusOf(id, "b@example.com")).status, "active");

    const rules = await import("./automations");
    await rules.saveRules(user.id, id, { ...NO_RULES, exitOnClick: true });
    await runAutomationCycle(); // email 2 queued for both, not yet delivered
    assert.equal(await count("SELECT COUNT(*) AS n FROM recipients WHERE status = 'pending'"), 2);

    // A now clicks: stopped at once, and the message already queued for A is skipped.
    await recordClick(await tokenFor("a@example.com", 0), "https://example.com/x");
    assert.deepEqual(await statusOf(id, "a@example.com"), { status: "stopped", reason: "clicked a link" });
    assert.equal((await statusOf(id, "b@example.com")).status, "active");
    await runBatch(10);
    const sql = await readySql();
    const skipped = (await sql
      .prepare("SELECT status, error FROM recipients WHERE email = ? AND status = 'skipped'")
      .get("a@example.com")) as { status: string; error: string } | null;
    assert.equal(skipped?.error, "Left the automation");
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "a@example.com"), 1, "only email 1 reached A");
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "b@example.com"), 2);

    // A stopped person gets nothing more.
    await fastForward(id);
    await runAutomationCycle();
    await runBatch(10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "a@example.com"), 1);
    const counts = await enrollmentCounts(id);
    assert.equal(counts.stopped, 1);
    assert.equal(counts.completed, 1);
  });
});

test("joining the exit list stops the series, but only for people who join it after enrolling", async () => {
  await withDatabase(async (ownerEmail) => {
    const { user, listId, id } = await setup(ownerEmail, ["email", 24, "email"]);
    const customers = await createList(user.id, "Customers");
    await saveRules(user.id, id, { ...NO_RULES, exitListId: customers });
    // Already a customer before joining the series: the exit does not apply.
    await addContact(user.id, { email: "early@example.com", firstName: "Early", lastName: "", listId: customers });
    await sleep(5);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await sleep(5);
    for (const email of ["early@example.com", "later@example.com", "racing@example.com"]) {
      await addContact(user.id, { email, firstName: email[0], lastName: "", listId });
    }
    await runAutomationCycle(); // enrolls all three and queues email 1 for each
    assert.equal((await enrollmentCounts(id)).total, 3);
    assert.equal(await count("SELECT COUNT(*) AS n FROM recipients WHERE status = 'pending'"), 3);

    await sleep(5);
    await addContact(user.id, { email: "later@example.com", firstName: "", lastName: "", listId: customers });
    assert.equal(await applyExitConditions() > 0, true);
    assert.deepEqual(await statusOf(id, "later@example.com"), { status: "stopped", reason: "joined exit list" });
    assert.equal((await statusOf(id, "early@example.com")).status, "active");
    assert.equal(await applyExitConditions(), 0, "running it again changes nothing");

    await runBatch(10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "later@example.com"), 0, "its queued email was skipped");
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "early@example.com"), 1);

    // Even before the sweep runs, a due step re-checks the exit list and sends nothing.
    await runAutomationCycle(); // moves everyone past the wait
    await fastForward(id);
    await sleep(5);
    await addContact(user.id, { email: "racing@example.com", firstName: "", lastName: "", listId: customers });
    const sql = await readySql();
    const racing = (await sql
      .prepare("SELECT id, current_step FROM automation_enrollments WHERE contact_id = ?")
      .get(await contactId(user.id, "racing@example.com"))) as { id: string; current_step: number | string };
    assert.equal(await advanceEnrollment(racing.id, Number(racing.current_step)), true);
    assert.equal((await statusOf(id, "racing@example.com")).reason, "joined exit list");
    assert.equal(await count("SELECT COUNT(*) AS n FROM recipients WHERE email = ?", "racing@example.com"), 1, "no second email was queued");
  });
});

test("email steps wait for the send window, delay steps do not", async () => {
  await withDatabase(async (ownerEmail) => {
    // Allow only tomorrow (UTC), all day, so "now" is always outside the window.
    const tomorrow = (new Date().getUTCDay() + 1) % 7;
    const window = { windowEnabled: true, windowDays: [tomorrow], windowStartHour: 0, windowEndHour: 24, timezone: "UTC" };
    const { user, listId, id } = await setup(ownerEmail, [1, "email"], window);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "w@example.com", firstName: "W", lastName: "", listId });

    await runAutomationCycle(); // enrolls and runs the delay step: not deferred
    let [row] = await recentEnrollments(user.id, id);
    assert.equal(row.currentStep, 1);
    assert.ok(new Date(row.nextRunAt).getTime() > Date.now());

    await fastForward(id);
    const before = new Date();
    await runAutomationCycle(); // the email step is due but outside the window: deferred
    const expected = nextAllowedTime(before, { days: [tomorrow], startHour: 0, endHour: 24, timezone: "UTC" });
    [row] = await recentEnrollments(user.id, id);
    assert.equal(row.status, "active");
    assert.equal(row.currentStep, 1);
    assert.equal(row.nextRunAt, expected?.toISOString());
    assert.ok(new Date(row.nextRunAt).getTime() > Date.now());
    assert.equal(await count("SELECT COUNT(*) AS n FROM recipients"), 0, "nothing queued outside the window");
    assert.equal(await runAutomationCycle(), 0, "and nothing happens until the window opens");

    // Open the window (every day) and the same step goes out.
    await saveRules(user.id, id, { ...NO_RULES, ...window, windowDays: [0, 1, 2, 3, 4, 5, 6] });
    await fastForward(id);
    await runAutomationCycle();
    await runBatch(10);
    const counts = await enrollmentCounts(id);
    assert.equal(counts.emailsSent, 1);
    assert.equal(counts.completed, 1);
  });
});

test("per-step stats count sent, opened, and clicked for each email step", async () => {
  await withDatabase(async (ownerEmail) => {
    const { user, listId, id } = await setup(ownerEmail, ["email", 1, "email"]);
    await activateAutomation(user.id, id, "http://localhost:3010");
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await addContact(user.id, { email, firstName: email[0], lastName: "", listId });
    }
    await runAutomationCycle();
    let stats = await stepStats(user.id, id);
    const steps = await listSteps(user.id, id);
    assert.equal(stats.get(steps[0].id)?.waiting, 3);
    assert.equal(stats.get(steps[0].id)?.sent, 0);
    await runBatch(10);

    const a = await tokenFor("a@example.com", 0);
    const b = await tokenFor("b@example.com", 0);
    await recordOpen(a);
    await recordOpen(a); // repeat opens count once
    await recordOpen(b);
    await recordClick(a, "https://example.com/x");
    stats = await stepStats(user.id, id);
    assert.deepEqual(stats.get(steps[0].id), { stepId: steps[0].id, sent: 3, failed: 0, waiting: 0, uniqueOpens: 2, uniqueClicks: 1 });
    assert.equal(stats.has(steps[1].id), false, "delay steps have no stats");
    assert.equal(stats.has(steps[2].id), false, "not reached yet");

    await runAutomationCycle(); // delay
    await fastForward(id);
    await runAutomationCycle(); // email 2
    await runBatch(10);
    await recordOpen(await tokenFor("c@example.com", 2));
    stats = await stepStats(user.id, id);
    assert.deepEqual(stats.get(steps[2].id), { stepId: steps[2].id, sent: 3, failed: 0, waiting: 0, uniqueOpens: 1, uniqueClicks: 0 });
    assert.equal(stats.get(steps[0].id)?.uniqueOpens, 2);
    // Another account never sees these numbers.
    assert.equal((await stepStats("someone-else", id)).size, 0);
  });
});
