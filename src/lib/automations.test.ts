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
  createAutomation,
  deleteAutomation,
  delayToMinutes,
  describeDelay,
  enrollmentCounts,
  enrollNewMembers,
  getAutomation,
  listAutomations,
  listSteps,
  moveStep,
  pauseAutomation,
  recentEnrollments,
  removeStep,
  runAutomationCycle,
  updateAutomation,
} from "./automations";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  deleteList,
  deleteTemplate,
  getCampaign,
  importContacts,
  listCampaigns,
  listTemplates,
  removeFromList,
  setContactStatus,
  unsubscribe,
  updateSettings,
} from "./queries";
import { closeSql, readySql } from "./sql";
import { runBatch, runWorkerCycle } from "./worker-cycle";

// Same approach as queue.test.ts: SQLite by default, Postgres when DATABASE_URL is set.

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

async function contactId(userId: string, email: string): Promise<string> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(userId, email)) as { id: string } | null;
  assert.ok(row, `contact ${email} exists`);
  return row.id;
}

async function unsubToken(userId: string, email: string): Promise<string> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT unsub_token AS t FROM contacts WHERE user_id = ? AND email = ?").get(userId, email)) as { t: string };
  return row.t;
}

/** Makes every active enrollment due now, standing in for the passing of time. */
async function fastForward(automationId: string): Promise<void> {
  const sql = await readySql();
  await sql
    .prepare("UPDATE automation_enrollments SET next_run_at = ? WHERE automation_id = ? AND status = 'active'")
    .run("2000-01-01T00:00:00.000Z", automationId);
}

async function deliveriesTo(email: string): Promise<{ subject: string; html: string; mode: string }[]> {
  const sql = await readySql();
  return (await sql
    .prepare("SELECT subject, html, mode FROM deliveries WHERE to_email = ? ORDER BY created_at, id")
    .all(email)) as { subject: string; html: string; mode: string }[];
}

test("delay helpers convert and describe durations", () => {
  assert.equal(delayToMinutes(30, "minutes"), 30);
  assert.equal(delayToMinutes(2, "hours"), 120);
  assert.equal(delayToMinutes(3, "days"), 4320);
  assert.throws(() => delayToMinutes(0, "days"), /whole number/);
  assert.throws(() => delayToMinutes(1.5, "hours"), /whole number/);
  assert.throws(() => delayToMinutes(1, "weeks"), /minutes, hours, or days/);
  assert.throws(() => delayToMinutes(366, "days"), /365 days/);
  assert.equal(describeDelay(1), "1 minute");
  assert.equal(describeDelay(90), "90 minutes");
  assert.equal(describeDelay(120), "2 hours");
  assert.equal(describeDelay(2880), "2 days");
  assert.equal(describeDelay(1440), "1 day");
});

test("a welcome series enrolls new list members once and sends each step through the normal pipeline", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada Lovelace", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const templates = await listTemplates(user.id);
    assert.ok(templates.length >= 2, "starter templates exist");
    const listId = await createList(user.id, "Welcome");
    // Already on the list before the automation starts: must not be enrolled.
    await addContact(user.id, { email: "old@example.com", firstName: "Old", lastName: "Timer", listId });

    const id = await createAutomation(user.id, { name: "Welcome series", listId });
    await assert.rejects(activateAutomation(user.id, id, "http://localhost:3010"), /at least one email step/);
    await addEmailStep(user.id, id, templates[0].id);
    await addDelayStep(user.id, id, 2, "days");
    await addEmailStep(user.id, id, templates[1].id);
    const steps = await listSteps(user.id, id);
    assert.deepEqual(
      steps.map((step) => [step.position, step.kind, step.delayMinutes]),
      [[0, "email", 0], [1, "delay", 2880], [2, "email", 0]],
    );
    assert.equal(steps[0].templateName, templates[0].name);

    // The hidden campaign never shows up with real campaigns.
    const automation = await getAutomation(user.id, id);
    assert.equal(automation?.status, "draft");
    assert.equal(automation?.stepCount, 3);
    assert.equal(automation?.emailCount, 2);
    assert.equal(await getCampaign(user.id, automation!.campaignId), null);
    assert.equal((await listCampaigns(user.id)).length, 0);

    // Nothing runs while it is a draft.
    await addContact(user.id, { email: "draft@example.com", firstName: "Draft", lastName: "", listId });
    assert.equal(await runAutomationCycle(), 0);

    await activateAutomation(user.id, id, "https://mail.example.com/");
    await assert.rejects(activateAutomation(user.id, id, "https://mail.example.com"), /already active/);
    await assert.rejects(addDelayStep(user.id, id, 1, "hours"), /Pause the automation/);

    await addContact(user.id, { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", listId });
    await addContact(user.id, { email: "grace@example.com", firstName: "Grace", lastName: "Hopper", listId });
    await setContactStatus(user.id, await contactId(user.id, "grace@example.com"), "unsubscribed");
    const imported = await importContacts(user.id, listId, "email,first name\nlinus@example.com,Linus\nada@example.com,Ada\nnot-an-email,No\n", { consentAttested: true });
    assert.equal(imported.addedToList, 1);

    // ada + linus enrolled; grace is unsubscribed; old and draft joined before activation.
    assert.equal(await enrollNewMembers(), 2);
    assert.equal(await enrollNewMembers(), 0, "enrolling twice is a no-op");
    let counts = await enrollmentCounts(id);
    assert.equal(counts.total, 2);
    assert.equal(counts.active, 2);

    // Step 1 (email): enqueued, not sent yet.
    assert.equal(await runAutomationCycle(), 2);
    counts = await enrollmentCounts(id);
    assert.equal(counts.emailsWaiting, 2);
    assert.equal(counts.emailsSent, 0);
    assert.equal(await runBatch(10), 2);
    counts = await enrollmentCounts(id);
    assert.equal(counts.emailsSent, 2);

    const first = await deliveriesTo("ada@example.com");
    assert.equal(first.length, 1);
    assert.equal(first[0].mode, "capture");
    assert.match(first[0].html, /Analytical Engines/);
    assert.match(first[0].html, /\/u\//);
    assert.match(first[0].html, /\/t\/o\//);
    assert.match(first[0].html, /https:\/\/mail\.example\.com\/u\//, "uses the origin saved at activation");
    assert.equal(first[0].html.includes("{{"), false, "merge tags are filled in");

    // Step 2 (delay): moves the enrollment to the future.
    assert.equal(await runAutomationCycle(), 2);
    assert.equal(await runAutomationCycle(), 0, "nothing is due during the delay");
    assert.equal(await runBatch(10), 0);
    const waiting = await recentEnrollments(user.id, id);
    assert.equal(waiting.length, 2);
    assert.ok(waiting.every((row) => row.status === "active" && row.currentStep === 2));
    assert.ok(waiting.every((row) => new Date(row.nextRunAt).getTime() > Date.now() + 47 * 3600 * 1000));

    // Linus unsubscribes during the delay: stopped, never sent the second email.
    await unsubscribe(await unsubToken(user.id, "linus@example.com"), null);
    counts = await enrollmentCounts(id);
    assert.equal(counts.stopped, 1);
    assert.equal(counts.active, 1);

    // Pausing stops processing even when due.
    await pauseAutomation(user.id, id);
    await fastForward(id);
    assert.equal(await runAutomationCycle(), 0);
    assert.equal(await runBatch(10), 0);
    await activateAutomation(user.id, id, "https://mail.example.com");

    // Step 3 (email) after the delay, then the series completes.
    assert.equal(await runWorkerCycle(10), 2, "one enrollment advanced and one message sent");
    counts = await enrollmentCounts(id);
    assert.equal(counts.completed, 1);
    assert.equal(counts.active, 0);
    assert.equal(counts.stopped, 1);
    assert.equal(counts.emailsSent, 3);
    assert.equal(counts.emailsFailed, 0);
    assert.equal((await deliveriesTo("ada@example.com")).length, 2);
    assert.equal((await deliveriesTo("linus@example.com")).length, 1);
    assert.equal((await deliveriesTo("grace@example.com")).length, 0);
    assert.equal((await deliveriesTo("old@example.com")).length, 0);

    // Finished people are never re-enrolled, even if removed from the list and added again.
    await removeFromList(user.id, listId, await contactId(user.id, "ada@example.com"));
    await addContact(user.id, { email: "ada@example.com", firstName: "", lastName: "", listId });
    assert.equal(await runAutomationCycle(), 0);
    assert.equal((await enrollmentCounts(id)).total, 2);

    const rows = await recentEnrollments(user.id, id);
    const stopped = rows.find((row) => row.email === "linus@example.com");
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.stopReason, "unsubscribed");
    assert.equal(rows.find((row) => row.email === "ada@example.com")?.status, "completed");
  });
});

test("the same step never runs twice, and unsubscribed people are never queued", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Grace Hopper", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const [template] = await listTemplates(user.id);
    const listId = await createList(user.id, "Drip");
    const id = await createAutomation(user.id, { name: "Drip", listId });
    await addEmailStep(user.id, id, template.id);
    await addDelayStep(user.id, id, 1, "hours");
    await addEmailStep(user.id, id, template.id);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "one@example.com", firstName: "One", lastName: "", listId });
    await addContact(user.id, { email: "two@example.com", firstName: "Two", lastName: "", listId });
    await enrollNewMembers();

    const sql = await readySql();
    const enrollment = (await sql
      .prepare("SELECT id, current_step FROM automation_enrollments WHERE contact_id = ?")
      .get(await contactId(user.id, "one@example.com"))) as { id: string; current_step: number | string };

    // Two workers racing on the same row: exactly one wins (real parallelism needs Postgres).
    const results = process.env.DATABASE_URL
      ? await Promise.all([advanceEnrollment(enrollment.id, 0), advanceEnrollment(enrollment.id, 0)])
      : [await advanceEnrollment(enrollment.id, 0), await advanceEnrollment(enrollment.id, 0)];
    assert.deepEqual(results.slice().sort(), [false, true]);
    const sends = (await sql
      .prepare("SELECT COUNT(*) AS n FROM automation_sends WHERE enrollment_id = ?")
      .get(enrollment.id)) as { n: number | string };
    assert.equal(Number(sends.n), 1);

    // Even if the step pointer were rewound, the (enrollment, step) record stops a second message.
    await sql.prepare("UPDATE automation_enrollments SET current_step = 0, next_run_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", enrollment.id);
    assert.equal(await advanceEnrollment(enrollment.id, 0), true);
    const again = (await sql
      .prepare("SELECT COUNT(*) AS n FROM automation_sends WHERE enrollment_id = ?")
      .get(enrollment.id)) as { n: number | string };
    assert.equal(Number(again.n), 1);

    // "two" unsubscribes after the step was queued but before the worker delivered it: skipped.
    assert.equal(await advanceEnrollment(
      ((await sql.prepare("SELECT id FROM automation_enrollments WHERE contact_id = ?").get(await contactId(user.id, "two@example.com"))) as { id: string }).id,
      0,
    ), true);
    await setContactStatus(user.id, await contactId(user.id, "two@example.com"), "unsubscribed");
    await runBatch(10);
    assert.equal((await deliveriesTo("two@example.com")).length, 0);
    assert.equal((await deliveriesTo("one@example.com")).length, 1);
    const twoStatus = (await sql
      .prepare("SELECT r.status, r.error FROM recipients r WHERE r.email = ?")
      .get("two@example.com")) as { status: string; error: string };
    assert.equal(twoStatus.status, "skipped");
    assert.equal(twoStatus.error, "Unsubscribed");
    assert.equal((await enrollmentCounts(id)).stopped, 1);
  });
});

test("editing rules: pause to edit, reorder, remove, template and list protection", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Linus", email: ownerEmail, password: "password123" });
    const [a, b] = await listTemplates(user.id);
    const listId = await createList(user.id, "People");
    const id = await createAutomation(user.id, { name: "  Onboarding ", listId: null });
    assert.equal((await getAutomation(user.id, id))?.name, "Onboarding");
    await assert.rejects(createAutomation(user.id, { name: "   ", listId: null }), /name/);
    await assert.rejects(createAutomation(user.id, { name: "x", listId: "missing" }), /List not found/);
    await assert.rejects(addEmailStep(user.id, id, "missing"), /Choose a template/);
    await addEmailStep(user.id, id, a.id);
    await addDelayStep(user.id, id, 30, "minutes");
    await addEmailStep(user.id, id, b.id);

    await assert.rejects(activateAutomation(user.id, id, "http://localhost:3010"), /Choose a list/);
    await updateAutomation(user.id, id, { name: "Onboarding", listId });
    await assert.rejects(activateAutomation(user.id, id, "http://localhost:3010"), /company name/);
    await updateSettings(user.id, SETTINGS);

    await assert.rejects(deleteTemplate(user.id, a.id), /used by the automation "Onboarding"/);

    let steps = await listSteps(user.id, id);
    await moveStep(user.id, id, steps[2].id, "up");
    await moveStep(user.id, id, steps[0].id, "up"); // already first: no change
    await moveStep(user.id, id, steps[0].id, "down");
    steps = await listSteps(user.id, id);
    assert.deepEqual(steps.map((step) => step.kind), ["email", "email", "delay"]);
    assert.deepEqual(steps.map((step) => step.templateId), [b.id, a.id, null]);
    await removeStep(user.id, id, steps[0].id);
    steps = await listSteps(user.id, id);
    assert.deepEqual(steps.map((step) => [step.position, step.kind]), [[0, "email"], [1, "delay"]]);
    await assert.rejects(removeStep(user.id, id, "missing"), /Step not found/);
    await removeStep(user.id, id, steps[1].id);
    steps = await listSteps(user.id, id);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await assert.rejects(updateAutomation(user.id, id, { name: "Renamed", listId }), /Pause/);
    await assert.rejects(removeStep(user.id, id, steps[0].id), /Pause/);
    await assert.rejects(moveStep(user.id, id, steps[0].id, "down"), /Pause/);

    // Deleting the list pauses the automation rather than leaving it running without a trigger.
    await deleteList(user.id, listId);
    const afterDelete = await getAutomation(user.id, id);
    assert.equal(afterDelete?.status, "paused");
    assert.equal(afterDelete?.listId, null);
    await assert.rejects(activateAutomation(user.id, id, "http://localhost:3010"), /Choose a list/);
    await assert.rejects(pauseAutomation(user.id, id), /not running/);

    // Deleting a template that an active step used is allowed once the step is gone.
    const [onlyStep] = await listSteps(user.id, id);
    await removeStep(user.id, id, onlyStep.id);
    await deleteTemplate(user.id, onlyStep.templateId!);

    await deleteAutomation(user.id, id);
    assert.equal(await getAutomation(user.id, id), null);
    assert.equal((await listAutomations(user.id)).length, 0);
    const sql = await readySql();
    const left = (await sql.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ?").get(user.id)) as { n: number | string };
    assert.equal(Number(left.n), 0, "the hidden campaign is removed with the automation");
  });
});

test("a deleted template is recorded as a failed message instead of being skipped silently", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const [template] = await listTemplates(user.id);
    const listId = await createList(user.id, "L");
    const id = await createAutomation(user.id, { name: "Broken", listId });
    await addEmailStep(user.id, id, template.id);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "x@example.com", firstName: "X", lastName: "", listId });
    const sql = await readySql();
    // Simulate the template vanishing after activation (the app blocks this; the database still allows it).
    await sql.prepare("DELETE FROM templates WHERE id = ?").run(template.id);
    await runAutomationCycle();
    await runBatch(10);
    const counts = await enrollmentCounts(id);
    assert.equal(counts.emailsFailed, 1);
    assert.equal(counts.emailsSent, 0);
    assert.equal(counts.completed, 1);
    assert.equal((await deliveriesTo("x@example.com")).length, 0);
  });
});
