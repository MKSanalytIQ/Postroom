import { createPublicKey, createVerify, X509Certificate, type KeyObject } from "crypto";

// Amazon SNS message signature verification, per
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
// Pure Node, no AWS SDK. The certificate fetcher can be replaced so tests never touch the network.

export type CertFetcher = (url: string) => Promise<string>;

export type SnsVerifyOptions = {
  /** Returns the PEM (certificate or public key) at a signing-certificate URL. Defaults to an HTTPS fetch with a timeout. */
  fetchCert?: CertFetcher;
  /** Current time in ms, for certificate validity and cache expiry. */
  now?: () => number;
};

export type SnsVerdict = { ok: true } | { ok: false; reason: string };

const CERT_TIMEOUT_MS = 5000;
const CERT_MAX_BYTES = 32_768;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 20;

/** https://sns.<region>.amazonaws.com[.cn]/...pem, no credentials, no custom port. */
export function isSnsCertUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname) &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      url.pathname.toLowerCase().endsWith(".pem") &&
      !url.search
    );
  } catch {
    return false;
  }
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CONFIRMATION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];

/**
 * The exact text SNS signed: "Name\nValue\n" pairs in alphabetical order, for the keys that belong to the
 * message type. Subject is only part of it when present. Returns null if a required field is missing.
 */
export function snsStringToSign(message: Record<string, unknown>): string | null {
  const type = message.Type;
  let keys: string[];
  if (type === "Notification") keys = NOTIFICATION_KEYS;
  else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") keys = CONFIRMATION_KEYS;
  else return null;
  let out = "";
  for (const key of keys) {
    const value = message[key];
    if (value === undefined || value === null) {
      if (key === "Subject") continue;
      return null;
    }
    if (typeof value !== "string") return null;
    out += `${key}\n${value}\n`;
  }
  return out;
}

async function defaultFetchCert(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CERT_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error(`Certificate request returned ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Certificate response had no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > CERT_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Certificate response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type CacheEntry = { key: Promise<KeyObject>; expires: number };
const cache = new Map<string, CacheEntry>();

export function clearSnsCertCache(): void {
  cache.clear();
}

function keyFromPem(pem: string, now: number): KeyObject {
  if (/-----BEGIN CERTIFICATE-----/.test(pem)) {
    const cert = new X509Certificate(pem);
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw new Error("The signing certificate is not currently valid.");
    return cert.publicKey;
  }
  return createPublicKey(pem);
}

/** Fetches (or reuses) the public key for a signing-certificate URL. Failures are not cached. */
function signingKey(url: string, options: SnsVerifyOptions, now: number): Promise<KeyObject> {
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.key;
  const fetchCert = options.fetchCert ?? defaultFetchCert;
  const key = fetchCert(url).then((pem) => keyFromPem(pem, now));
  if (cache.size >= CACHE_MAX) {
    for (const [oldUrl, entry] of cache) if (entry.expires <= now) cache.delete(oldUrl);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  const entry = { key, expires: now + CACHE_TTL_MS };
  cache.set(url, entry);
  key.catch(() => {
    if (cache.get(url) === entry) cache.delete(url);
  });
  return key;
}

/** Checks one SNS envelope: signature version, certificate URL, and the signature itself. */
export async function verifySnsMessage(message: Record<string, unknown>, options: SnsVerifyOptions = {}): Promise<SnsVerdict> {
  const version = message.SignatureVersion;
  const algorithm = version === "1" ? "RSA-SHA1" : version === "2" ? "RSA-SHA256" : null;
  if (!algorithm) return { ok: false, reason: "Unsupported or missing SignatureVersion." };
  const signature = message.Signature;
  if (typeof signature !== "string" || !signature || !/^[A-Za-z0-9+/=\s]+$/.test(signature)) {
    return { ok: false, reason: "Missing or malformed Signature." };
  }
  const certUrl = message.SigningCertURL ?? message.SigningCertUrl;
  if (!isSnsCertUrl(certUrl)) return { ok: false, reason: "SigningCertURL must be an https://sns.<region>.amazonaws.com .pem link." };
  const text = snsStringToSign(message);
  if (text === null) return { ok: false, reason: "The message is missing fields that SNS signs." };
  const now = (options.now ?? Date.now)();
  try {
    const key = await signingKey(certUrl, options, now);
    const verifier = createVerify(algorithm);
    verifier.update(text, "utf8");
    verifier.end();
    return verifier.verify(key, signature.replace(/\s+/g, ""), "base64") ? { ok: true } : { ok: false, reason: "The signature does not match." };
  } catch (error) {
    return { ok: false, reason: `Could not verify the signature: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}
