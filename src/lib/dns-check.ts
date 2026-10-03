import { promises as dns } from "dns";
import { isEmail, normalizeEmail } from "./validators";

// Sender verification: looks up the SPF, DKIM, and DMARC DNS records for the From address's domain
// and explains the result in plain language. The resolver is injectable so tests need no network.

export type CheckStatus = "pass" | "warn" | "missing";

export type DnsCheck = {
  status: CheckStatus;
  /** The record that was found, if any. */
  record: string | null;
  /** What to tell the user. */
  message: string;
};

export type SenderCheck = {
  domain: string;
  selector: string;
  spf: DnsCheck;
  dkim: DnsCheck;
  dmarc: DnsCheck;
  overall: CheckStatus;
};

export type TxtResolver = { resolveTxt(name: string): Promise<string[][]> };

const RANK: Record<CheckStatus, number> = { pass: 0, warn: 1, missing: 2 };

export function defaultResolver(): TxtResolver {
  const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
  return { resolveTxt: (name) => resolver.resolveTxt(name) };
}

export function domainOf(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized)) return null;
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

class LookupFailed extends Error {}

/** TXT records for a name, each joined from its chunks. "No such record" is an empty list; other errors throw. */
async function txt(resolver: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return [];
    throw new LookupFailed(`the DNS lookup for ${name} failed${code ? ` (${code})` : ""}`);
  }
}

function lookupWarning(error: unknown): DnsCheck {
  const reason = error instanceof LookupFailed ? error.message : "the DNS lookup failed";
  return { status: "warn", record: null, message: `Could not check this: ${reason}. Try again in a moment.` };
}

async function checkSpf(resolver: TxtResolver, domain: string): Promise<DnsCheck> {
  try {
    const records = (await txt(resolver, domain)).filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));
    if (records.length === 0) {
      return {
        status: "missing",
        record: null,
        message: `No SPF record on ${domain}. SPF tells receiving servers which services may send as your domain. Ask your email provider for the record to add (it looks like "v=spf1 include:your-provider.example ~all") and publish it as a TXT record on ${domain}.`,
      };
    }
    if (records.length > 1) {
      return {
        status: "warn",
        record: records[0],
        message: `${domain} has ${records.length} SPF records. Only one is allowed, and receivers treat several as an error. Merge them into a single TXT record.`,
      };
    }
    const record = records[0].trim();
    const all = /(?:^|\s)([+?~-]?)all(?:\s|$)/i.exec(record);
    if (!all && /(?:^|\s)redirect=/i.test(record)) {
      return { status: "pass", record, message: "SPF is published and points to another domain's policy." };
    }
    if (!all || all[1] === "+" || all[1] === "?") {
      return {
        status: "warn",
        record,
        message: `The SPF record does not end in "~all" or "-all", so it does not tell receivers to distrust other senders. End the record with "~all" (or "-all" once you are sure every sender is listed).`,
      };
    }
    return { status: "pass", record, message: "SPF is published." };
  } catch (error) {
    return lookupWarning(error);
  }
}

async function checkDkim(resolver: TxtResolver, domain: string, selector: string): Promise<DnsCheck> {
  const name = `${selector}._domainkey.${domain}`;
  try {
    const record = (await txt(resolver, name)).find((value) => /(^|;)\s*(v=DKIM1|p=)/i.test(value));
    if (!record) {
      return {
        status: "missing",
        record: null,
        message: `No DKIM key at ${name}. DKIM signs your mail so receivers know it was not altered. Your email provider gives you a key (or a CNAME) to publish at that name. If your provider uses a different selector, enter it above and check again.`,
      };
    }
    const key = /(?:^|;)\s*p=([^;]*)/i.exec(record)?.[1]?.trim() ?? "";
    if (!key) {
      return {
        status: "warn",
        record,
        message: `The DKIM record at ${name} has an empty public key, which means the key was revoked. Publish the current key from your email provider.`,
      };
    }
    return { status: "pass", record: record.length > 120 ? `${record.slice(0, 117)}...` : record, message: `DKIM key found for selector "${selector}".` };
  } catch (error) {
    return lookupWarning(error);
  }
}

async function checkDmarc(resolver: TxtResolver, domain: string): Promise<DnsCheck> {
  try {
    // A subdomain with no policy of its own inherits the parent's, so look up the chain.
    const labels = domain.split(".");
    for (let start = 0; labels.length - start >= 2; start += 1) {
      const candidate = labels.slice(start).join(".");
      const record = (await txt(resolver, `_dmarc.${candidate}`)).find((value) => /^v=DMARC1\b/i.test(value.trim()));
      if (!record) continue;
      const policy = /(?:^|;)\s*p=\s*(none|quarantine|reject)/i.exec(record)?.[1]?.toLowerCase();
      const inherited = candidate === domain ? "" : ` (inherited from ${candidate})`;
      if (!policy) {
        return { status: "warn", record, message: `A DMARC record exists${inherited} but has no valid "p=" policy. Add p=none to start, then tighten it.` };
      }
      if (policy === "none") {
        return {
          status: "warn",
          record,
          message: `DMARC${inherited} is in monitoring mode (p=none). That is a fine start, but receivers will not act on failures. Once SPF and DKIM pass, move to p=quarantine or p=reject.`,
        };
      }
      return { status: "pass", record, message: `DMARC${inherited} is published with policy ${policy}.` };
    }
    return {
      status: "missing",
      record: null,
      message: `No DMARC record at _dmarc.${domain}. DMARC tells receivers what to do with mail that fails SPF and DKIM, and large mailbox providers now expect it. Publish a TXT record there such as "v=DMARC1; p=none; rua=mailto:you@${domain}" to begin.`,
    };
  } catch (error) {
    return lookupWarning(error);
  }
}

/** Checks SPF, DKIM, and DMARC for the domain of a From address. Returns null when the address has no usable domain. */
export async function checkSender(fromEmail: string, selector: string, resolver: TxtResolver = defaultResolver()): Promise<SenderCheck | null> {
  const domain = domainOf(fromEmail);
  if (!domain) return null;
  const chosen = selector.trim() || "default";
  const [spf, dkim, dmarc] = await Promise.all([checkSpf(resolver, domain), checkDkim(resolver, domain, chosen), checkDmarc(resolver, domain)]);
  const overall = [spf, dkim, dmarc].reduce<CheckStatus>((worst, check) => (RANK[check.status] > RANK[worst] ? check.status : worst), "pass");
  return { domain, selector: chosen, spf, dkim, dmarc, overall };
}

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; check: SenderCheck | null }>();

/**
 * Short, non-blocking warnings for review and activation screens, for example
 * ["SPF is missing for example.com"]. Empty when nothing is wrong, when mail is not really being sent
 * (capture mode), or when DNS could not be reached at all. Never throws.
 */
export async function senderWarnings(input: {
  fromEmail: string;
  selector: string;
  smtpConfigured: boolean;
  resolver?: TxtResolver;
}): Promise<string[]> {
  if (!input.smtpConfigured) return [];
  try {
    const key = `${normalizeEmail(input.fromEmail)}|${input.selector}`;
    const hit = cache.get(key);
    let check: SenderCheck | null;
    if (!input.resolver && hit && Date.now() - hit.at < CACHE_MS) check = hit.check;
    else {
      check = await checkSender(input.fromEmail, input.selector, input.resolver);
      if (!input.resolver) cache.set(key, { at: Date.now(), check });
    }
    if (!check) return [];
    const labels: [string, DnsCheck][] = [["SPF", check.spf], ["DKIM", check.dkim], ["DMARC", check.dmarc]];
    return labels
      .filter(([, result]) => result.status !== "pass" && !result.message.startsWith("Could not check"))
      .map(([label, result]) => `${label} is ${result.status === "missing" ? "missing" : "not set up properly"} for ${check.domain}`);
  } catch {
    return [];
  }
}

export function clearSenderCache(): void {
  cache.clear();
}
