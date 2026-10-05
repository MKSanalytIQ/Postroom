import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { clearSnsCertCache, isSnsCertUrl, snsStringToSign, verifySnsMessage } from "./sns";
import { makeSnsKit, TEST_CERT_URL } from "./sns-test-helpers";

test("the string to sign follows the AWS layout for each message type", () => {
  const notification = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: "arn:t",
    Subject: "Hello",
    Message: "Body",
    Timestamp: "2026-10-03T08:00:00.000Z",
    Signature: "ignored",
    SignatureVersion: "1",
    UnsubscribeURL: "ignored",
  };
  assert.equal(
    snsStringToSign(notification),
    "Message\nBody\nMessageId\nm-1\nSubject\nHello\nTimestamp\n2026-10-03T08:00:00.000Z\nTopicArn\narn:t\nType\nNotification\n",
  );
  const noSubject = Object.fromEntries(Object.entries(notification).filter(([key]) => key !== "Subject"));
  assert.equal(snsStringToSign(noSubject), "Message\nBody\nMessageId\nm-1\nTimestamp\n2026-10-03T08:00:00.000Z\nTopicArn\narn:t\nType\nNotification\n");
  assert.equal(
    snsStringToSign({ Type: "SubscriptionConfirmation", MessageId: "m", Message: "x", SubscribeURL: "https://u", Token: "tok", Timestamp: "t", TopicArn: "a" }),
    "Message\nx\nMessageId\nm\nSubscribeURL\nhttps://u\nTimestamp\nt\nToken\ntok\nTopicArn\na\nType\nSubscriptionConfirmation\n",
  );
  assert.equal(snsStringToSign({ Type: "Notification", Message: "x" }), null, "missing fields");
  assert.equal(snsStringToSign({ Type: "Other" }), null);
  assert.equal(snsStringToSign({ ...noSubject, Message: 5 }), null, "non-string values are refused");
});

test("only SNS signing certificate URLs on amazonaws.com over https are accepted", () => {
  assert.equal(isSnsCertUrl(TEST_CERT_URL), true);
  assert.equal(isSnsCertUrl("https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-x.pem"), true);
  for (const bad of [
    "http://sns.us-east-1.amazonaws.com/x.pem",
    "https://sns.us-east-1.amazonaws.com/x.crt",
    "https://sns.us-east-1.amazonaws.com/x.pem?a=1",
    "https://sns.us-east-1.amazonaws.com:8443/x.pem",
    "https://user:pw@sns.us-east-1.amazonaws.com/x.pem",
    "https://sns.us-east-1.amazonaws.com.evil.example/x.pem",
    "https://evil.example/sns.us-east-1.amazonaws.com/x.pem",
    "https://s3.us-east-1.amazonaws.com/x.pem",
    "https://xsns.us-east-1.amazonaws.com/x.pem",
    "not a url",
    "",
    null,
    42,
  ]) {
    assert.equal(isSnsCertUrl(bad), false, String(bad));
  }
});

test("a real signature verifies for SignatureVersion 1 and 2, and tampering is caught", async () => {
  clearSnsCertCache();
  const kit = makeSnsKit();
  for (const version of ["1", "2"] as const) {
    const signed = kit.sign({ Type: "Notification", MessageId: "m", TopicArn: "a", Timestamp: "t", Message: "hello", Subject: "s" }, version);
    assert.deepEqual(await verifySnsMessage(signed, kit.options), { ok: true }, `version ${version}`);
    const changed = await verifySnsMessage({ ...signed, Message: "hello!" }, kit.options);
    assert.equal(changed.ok, false);
    const swapped = await verifySnsMessage({ ...signed, SignatureVersion: version === "1" ? "2" : "1" }, kit.options);
    assert.equal(swapped.ok, false, "the algorithm must match the version");
  }
  const confirmation = kit.subscription("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc");
  assert.deepEqual(await verifySnsMessage(confirmation, kit.options), { ok: true });
  assert.equal((await verifySnsMessage({ ...confirmation, SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=evil" }, kit.options)).ok, false, "SubscribeURL is signed");
  assert.equal((await verifySnsMessage({ ...confirmation, Token: "other" }, kit.options)).ok, false, "Token is signed");
  // A signature made by another key does not verify.
  const stranger = makeSnsKit();
  assert.equal((await verifySnsMessage(stranger.notification("hello"), kit.options)).ok, false);
});

test("malformed envelopes are rejected before any certificate is fetched", async () => {
  clearSnsCertCache();
  const kit = makeSnsKit();
  const good = kit.notification("hello");
  const cases: Record<string, unknown>[] = [
    { ...good, SignatureVersion: undefined },
    { ...good, SignatureVersion: "3" },
    { ...good, Signature: undefined },
    { ...good, Signature: "***" },
    { ...good, SigningCertURL: undefined },
    { ...good, SigningCertURL: "https://evil.example/cert.pem" },
    { ...good, SigningCertURL: "http://sns.us-east-1.amazonaws.com/cert.pem" },
    { ...good, MessageId: undefined },
  ];
  for (const message of cases) {
    const verdict = await verifySnsMessage(message, kit.options);
    assert.equal(verdict.ok, false, JSON.stringify(message).slice(0, 80));
  }
  assert.deepEqual(kit.fetches, [], "nothing was fetched for a bad envelope");
});

test("the signing key is cached, refetched after it expires, and failures are not cached", async () => {
  clearSnsCertCache();
  const kit = makeSnsKit();
  let clock = 1_000_000;
  const options = { ...kit.options, now: () => clock };
  assert.equal((await verifySnsMessage(kit.notification("one"), options)).ok, true);
  assert.equal((await verifySnsMessage(kit.notification("two"), options)).ok, true);
  assert.equal(kit.fetches.length, 1, "second message reuses the cached key");
  clock += 61 * 60 * 1000;
  assert.equal((await verifySnsMessage(kit.notification("three"), options)).ok, true);
  assert.equal(kit.fetches.length, 2, "an hour later the certificate is fetched again");

  clearSnsCertCache();
  let attempts = 0;
  const flaky = {
    fetchCert: async (url: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("timed out");
      return kit.options.fetchCert!(url);
    },
  };
  const first = await verifySnsMessage(kit.notification("x"), flaky);
  assert.equal(first.ok, false);
  assert.match((first as { reason: string }).reason, /timed out/);
  assert.equal((await verifySnsMessage(kit.notification("x"), flaky)).ok, true, "the next message tries again");

  clearSnsCertCache();
  const garbage = await verifySnsMessage(kit.notification("x"), { fetchCert: async () => "not a pem" });
  assert.equal(garbage.ok, false);
});

test("an X.509 certificate works as the signing key, and an expired one does not", async (t) => {
  let dir = "";
  let pem = "";
  let keyFile = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-cert-"));
    keyFile = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "30", "-subj", "/CN=sns.test"], { stdio: "ignore" });
    pem = fs.readFileSync(certFile, "utf8");
  } catch {
    t.skip("openssl is not available");
    return;
  }
  try {
    const { createPrivateKey, createSign } = await import("crypto");
    const key = createPrivateKey(fs.readFileSync(keyFile, "utf8"));
    const base = { Type: "Notification", MessageId: "m", TopicArn: "a", Timestamp: "t", Message: "hi", SignatureVersion: "2", SigningCertURL: TEST_CERT_URL };
    const signer = createSign("RSA-SHA256");
    signer.update(snsStringToSign(base)!, "utf8");
    const message = { ...base, Signature: signer.sign(key, "base64") };
    clearSnsCertCache();
    assert.deepEqual(await verifySnsMessage(message, { fetchCert: async () => pem }), { ok: true });
    clearSnsCertCache();
    const expired = await verifySnsMessage(message, { fetchCert: async () => pem, now: () => Date.now() + 365 * 86_400_000 });
    assert.equal(expired.ok, false);
    assert.match((expired as { reason: string }).reason, /not currently valid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
