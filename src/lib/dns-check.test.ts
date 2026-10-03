import assert from "node:assert/strict";
import test from "node:test";
import { checkSender, clearSenderCache, domainOf, senderWarnings, type TxtResolver } from "./dns-check";

/** name -> TXT records (each a list of chunks), or an error code to throw. */
function fakeDns(zone: Record<string, string[][] | string>): TxtResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async resolveTxt(name) {
      asked.push(name);
      const entry = zone[name];
      if (entry === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      if (typeof entry === "string") throw Object.assign(new Error(entry), { code: entry });
      return entry;
    },
  };
}

const GOOD = {
  "example.com": [["v=spf1 include:mail.example.net ~all"]],
  "default._domainkey.example.com": [["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"]],
  "_dmarc.example.com": [["v=DMARC1; p=quarantine; rua=mailto:d@example.com"]],
};

test("everything published: all three pass", async () => {
  const result = await checkSender("Sales@Example.com", "", fakeDns(GOOD));
  assert.equal(result?.domain, "example.com");
  assert.equal(result?.selector, "default");
  assert.deepEqual([result?.spf.status, result?.dkim.status, result?.dmarc.status, result?.overall], ["pass", "pass", "pass", "pass"]);
  assert.match(result!.dmarc.message, /quarantine/);
});

test("nothing published: each is missing, with guidance that names the domain", async () => {
  const result = await checkSender("me@example.com", "s1", fakeDns({}));
  assert.deepEqual([result?.spf.status, result?.dkim.status, result?.dmarc.status, result?.overall], ["missing", "missing", "missing", "missing"]);
  assert.match(result!.spf.message, /No SPF record on example\.com/);
  assert.match(result!.dkim.message, /s1\._domainkey\.example\.com/);
  assert.match(result!.dmarc.message, /_dmarc\.example\.com/);
});

test("SPF: split chunks, weak endings, duplicates, and redirect", async () => {
  const check = async (records: string[][]) => (await checkSender("a@example.com", "default", fakeDns({ ...GOOD, "example.com": records })))!.spf;
  assert.equal((await check([["v=spf1 include:a.example ", "-all"]])).status, "pass", "chunks are joined");
  assert.equal((await check([["v=spf1 include:a.example +all"]])).status, "warn");
  assert.equal((await check([["v=spf1 include:a.example ?all"]])).status, "warn");
  assert.equal((await check([["v=spf1 include:a.example"]])).status, "warn");
  assert.equal((await check([["v=spf1 include:a.example ~all"], ["v=spf1 include:b.example ~all"]])).status, "warn");
  assert.equal((await check([["v=spf1 redirect=_spf.example.net"]])).status, "pass");
  assert.equal((await check([["google-site-verification=abc"], ["v=spf1 mx -all"]])).status, "pass", "unrelated TXT records are ignored");
  assert.equal((await check([["google-site-verification=abc"]])).status, "missing");
});

test("DKIM: key present, revoked key, and a different selector", async () => {
  const check = async (selector: string, zone: Record<string, string[][]>) => (await checkSender("a@example.com", selector, fakeDns({ ...GOOD, ...zone })))!.dkim;
  assert.equal((await check("default", {})).status, "pass");
  assert.equal((await check("default", { "default._domainkey.example.com": [["v=DKIM1; k=rsa; p="]] })).status, "warn");
  assert.equal((await check("mail", {})).status, "missing", "the default key does not count for another selector");
  assert.equal((await check("mail", { "mail._domainkey.example.com": [["k=rsa; p=ABCDEF"]] })).status, "pass");
});

test("DMARC: monitoring mode warns, subdomains inherit the parent's policy", async () => {
  const dmarc = async (from: string, zone: Record<string, string[][]>) => (await checkSender(from, "default", fakeDns(zone)))!.dmarc;
  const none = await dmarc("a@example.com", { "_dmarc.example.com": [["v=DMARC1; p=none"]] });
  assert.equal(none.status, "warn");
  assert.match(none.message, /p=none/);
  assert.equal((await dmarc("a@example.com", { "_dmarc.example.com": [["v=DMARC1; rua=mailto:x@example.com"]] })).status, "warn");
  const inherited = await dmarc("a@news.example.com", { "_dmarc.example.com": [["v=DMARC1; p=reject"]] });
  assert.equal(inherited.status, "pass");
  assert.match(inherited.message, /inherited from example\.com/);
  assert.equal((await dmarc("a@news.example.com", { "_dmarc.news.example.com": [["v=DMARC1; p=reject"]], "_dmarc.example.com": [["v=DMARC1; p=none"]] })).status, "pass");
  const dns = fakeDns({});
  await checkSender("a@deep.news.example.com", "default", dns);
  assert.ok(dns.asked.includes("_dmarc.example.com"));
  assert.equal(dns.asked.includes("_dmarc.com"), false, "never looks at a top-level domain");
});

test("lookup errors are a warning to retry, not a verdict", async () => {
  const result = await checkSender("a@example.com", "default", fakeDns({ ...GOOD, "example.com": "ETIMEOUT" }));
  assert.equal(result?.spf.status, "warn");
  assert.match(result!.spf.message, /Could not check this/);
  assert.equal(result?.dkim.status, "pass");
});

test("addresses without a domain, and the short warnings used on review screens", async () => {
  assert.equal(domainOf("not-an-email"), null);
  assert.equal(await checkSender("", "default", fakeDns({})), null);
  clearSenderCache();
  const none = fakeDns({});
  assert.deepEqual(await senderWarnings({ fromEmail: "a@example.com", selector: "default", smtpConfigured: false, resolver: none }), [], "capture mode sends nothing, so no warnings");
  assert.deepEqual(await senderWarnings({ fromEmail: "a@example.com", selector: "default", smtpConfigured: true, resolver: fakeDns(GOOD) }), []);
  assert.deepEqual(await senderWarnings({ fromEmail: "a@example.com", selector: "default", smtpConfigured: true, resolver: none }), [
    "SPF is missing for example.com",
    "DKIM is missing for example.com",
    "DMARC is missing for example.com",
  ]);
  const weak = fakeDns({ ...GOOD, "_dmarc.example.com": [["v=DMARC1; p=none"]] });
  assert.deepEqual(await senderWarnings({ fromEmail: "a@example.com", selector: "default", smtpConfigured: true, resolver: weak }), ["DMARC is not set up properly for example.com"]);
  const down = fakeDns({ "example.com": "ETIMEOUT", "default._domainkey.example.com": "ETIMEOUT", "_dmarc.example.com": "ETIMEOUT" });
  assert.deepEqual(await senderWarnings({ fromEmail: "a@example.com", selector: "default", smtpConfigured: true, resolver: down }), [], "no network means no false alarms");
});
