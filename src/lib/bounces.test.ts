import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeliveryError, isSnsSubscribeUrl, parseWebhookPayload } from "./bounces";

function sns(message: unknown) {
  return { Type: "Notification", MessageId: "1", Message: JSON.stringify(message) };
}

test("Amazon SES bounce notifications through SNS", () => {
  const permanent = parseWebhookPayload(
    sns({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "Gone@Example.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" },
          { emailAddress: "Also Gone <also@example.com>" },
          { emailAddress: "not an address" },
        ],
      },
    }),
  );
  assert.deepEqual(
    permanent.events.map((event) => [event.kind, event.email, event.permanent]),
    [["bounce", "gone@example.com", true], ["bounce", "also@example.com", true]],
  );
  assert.equal(permanent.events[0].reason, "smtp; 550 5.1.1 user unknown");
  assert.equal(permanent.events[1].reason, "Permanent / General");

  const transient = parseWebhookPayload(
    sns({ notificationType: "Bounce", bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "full@example.com" }] } }),
  );
  assert.equal(transient.events[0].permanent, false);
});

test("Amazon SES complaints, deliveries, and event-publishing format", () => {
  const complaint = parseWebhookPayload(
    sns({ notificationType: "Complaint", complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "mad@example.com" }] } }),
  );
  assert.deepEqual(complaint.events, [{ kind: "complaint", email: "mad@example.com", permanent: true, reason: "abuse" }]);
  const delivery = parseWebhookPayload(sns({ notificationType: "Delivery", delivery: { recipients: ["ok@example.com"] } }));
  assert.deepEqual(delivery.events.map((event) => [event.kind, event.email]), [["delivery", "ok@example.com"]]);
  // Event publishing uses eventType and can be posted raw, without the SNS envelope.
  const published = parseWebhookPayload({ eventType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "raw@example.com" }] } });
  assert.equal(published.events[0].email, "raw@example.com");
  assert.equal(published.events[0].permanent, true);
});

test("SNS subscription confirmation is only followed for real Amazon SNS links", () => {
  const good = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn&Token=abc";
  assert.equal(parseWebhookPayload({ Type: "SubscriptionConfirmation", SubscribeURL: good }).confirmUrl, good);
  for (const bad of [
    "http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    "https://evil.example.com/?Action=ConfirmSubscription",
    "https://sns.us-east-1.amazonaws.com.evil.com/?Action=ConfirmSubscription",
    "https://sns.us-east-1.amazonaws.com/?Action=Other",
    "https://169.254.169.254/?Action=ConfirmSubscription",
    "not a url",
  ]) {
    assert.equal(isSnsSubscribeUrl(bad), false, bad);
    const parsed = parseWebhookPayload({ Type: "SubscriptionConfirmation", SubscribeURL: bad });
    assert.equal(parsed.confirmUrl, null);
    assert.equal(parsed.ignored, 1);
  }
  assert.equal(isSnsSubscribeUrl(42), false);
});

test("the generic JSON format: single events, arrays, and wrappers", () => {
  const single = parseWebhookPayload({ type: "bounce", email: "A@Example.com", reason: "no such user" });
  assert.deepEqual(single.events, [{ kind: "bounce", email: "a@example.com", permanent: true, reason: "no such user" }]);
  assert.equal(parseWebhookPayload({ type: "bounce", email: "a@example.com", permanent: false }).events[0].permanent, false);
  assert.equal(parseWebhookPayload({ type: "soft_bounce", email: "a@example.com" }).events[0].permanent, false);
  assert.equal(parseWebhookPayload({ type: "hard-bounce", email: "a@example.com" }).events[0].permanent, true);
  assert.equal(parseWebhookPayload({ type: "spam", email: "a@example.com" }).events[0].kind, "complaint");
  assert.equal(parseWebhookPayload({ type: "delivered", email: "a@example.com" }).events[0].kind, "delivery");
  const many = parseWebhookPayload([
    { type: "bounce", email: "one@example.com" },
    { type: "complaint", email: "two@example.com" },
    { type: "open", email: "three@example.com" },
    { type: "bounce", email: "bad" },
  ]);
  assert.deepEqual(many.events.map((event) => event.email), ["one@example.com", "two@example.com"]);
  assert.equal(many.ignored, 2);
  const wrapped = parseWebhookPayload({ events: [{ type: "complaint", email: "w@example.com" }] });
  assert.equal(wrapped.events.length, 1);
  assert.deepEqual(parseWebhookPayload("nonsense").events, []);
  assert.equal(parseWebhookPayload(null).ignored, 1);
  assert.equal(parseWebhookPayload(sns("not an object")).ignored, 1);
});

test("only a permanent refusal of the recipient counts as a hard bounce", () => {
  const smtp = (responseCode: number, response: string, code = "EENVELOPE") => classifyDeliveryError(Object.assign(new Error(response), { code, responseCode, response }));
  assert.equal(smtp(550, "550 5.1.1 <x@example.com>: Recipient address rejected: User unknown").kind, "hard_bounce");
  assert.equal(smtp(550, "550 No such user here").kind, "hard_bounce");
  assert.equal(smtp(553, "553 Invalid recipient").kind, "hard_bounce");
  assert.equal(smtp(554, "554 5.1.2 Bad destination system address", "EMESSAGE").kind, "hard_bounce");
  assert.equal(smtp(550, "550 5.2.1 Mailbox disabled").kind, "hard_bounce");
  // The address is fine; the problem is the sender, the message, or the receiving policy.
  assert.equal(smtp(550, "550 5.7.1 Message blocked as spam").kind, "other");
  assert.equal(smtp(554, "554 Message rejected: Email address is not verified.", "EENVELOPE").kind, "other");
  assert.equal(smtp(550, "550 Relay access denied").kind, "other");
  assert.equal(smtp(550, "550 5.2.2 Mailbox full").kind, "other");
  assert.equal(smtp(552, "552 Message size exceeds limit").kind, "other");
  assert.equal(smtp(550, "550 Sender address rejected: not owned by user").kind, "other");
  // Temporary, authentication, and connection problems are never bounces.
  assert.equal(smtp(450, "450 4.2.0 Mailbox busy").kind, "other");
  assert.equal(smtp(535, "535 5.7.8 Authentication failed", "EAUTH").kind, "other");
  assert.equal(classifyDeliveryError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })).kind, "other");
  assert.equal(classifyDeliveryError("weird").kind, "other");
  assert.equal(classifyDeliveryError(null).message, "Send failed");
});
