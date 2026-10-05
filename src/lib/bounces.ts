import { isEmail, normalizeEmail } from "./validators";

// Pure parsing for bounce and complaint reports. No database or network access here.

export type WebhookEvent = {
  kind: "bounce" | "complaint" | "delivery";
  email: string;
  /** For bounces: true when the address is permanently undeliverable (so it should be suppressed). */
  permanent: boolean;
  reason: string;
};

export type ParsedWebhook = {
  events: WebhookEvent[];
  /** Amazon SNS asks the endpoint to visit this URL once to confirm the subscription. */
  confirmUrl: string | null;
  /** Items that were understood as JSON but not as an event (ignored, not an error). */
  ignored: number;
  /** SNS envelopes that were skipped because they were not in the verified set. Always 0 when no set is given. */
  unverified: number;
};

export type ParseOptions = {
  /** When given, only SNS envelopes in this set are trusted; any other SNS-shaped object is skipped and counted. */
  verifiedSns?: ReadonlySet<object>;
};

/** Only follow an SNS confirmation link that really points at Amazon SNS over HTTPS. */
export function isSnsSubscribeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname) &&
      url.pathname === "/" &&
      url.searchParams.get("Action") === "ConfirmSubscription"
    );
  } catch {
    return false;
  }
}

function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bracket = value.match(/<([^<>]+)>/);
  const email = normalizeEmail(bracket ? bracket[1] : value);
  return isEmail(email) ? email : null;
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Amazon SES notifications and SES event publishing (they differ only in the name of the type field). */
function parseSes(message: Record<string, unknown>): WebhookEvent[] {
  const type = text(message.notificationType || message.eventType).toLowerCase();
  const events: WebhookEvent[] = [];
  if (type === "bounce") {
    const bounce = record(message.bounce) ?? {};
    const permanent = text(bounce.bounceType).toLowerCase() === "permanent";
    for (const item of list(bounce.bouncedRecipients)) {
      const entry = record(item) ?? {};
      const email = cleanAddress(entry.emailAddress);
      if (!email) continue;
      const reason = text(entry.diagnosticCode) || [text(bounce.bounceType), text(bounce.bounceSubType)].filter(Boolean).join(" / ");
      events.push({ kind: "bounce", email, permanent, reason });
    }
  } else if (type === "complaint") {
    const complaint = record(message.complaint) ?? {};
    for (const item of list(complaint.complainedRecipients)) {
      const email = cleanAddress(record(item)?.emailAddress);
      if (email) events.push({ kind: "complaint", email, permanent: true, reason: text(complaint.complaintFeedbackType) || "complaint" });
    }
  } else if (type === "delivery") {
    const delivery = record(message.delivery) ?? {};
    for (const item of list(delivery.recipients)) {
      const email = cleanAddress(item);
      if (email) events.push({ kind: "delivery", email, permanent: false, reason: "" });
    }
  }
  return events;
}

/** The simple Postroom format: { "type": "bounce" | "complaint" | "delivery", "email": "...", "permanent"?: bool, "reason"?: "..." }. */
function parseGeneric(item: Record<string, unknown>): WebhookEvent | null {
  const type = text(item.type || item.event).toLowerCase().replace(/[\s-]+/g, "_");
  const email = cleanAddress(item.email ?? item.recipient);
  if (!email) return null;
  const reason = text(item.reason || item.description);
  if (type === "complaint" || type === "spam" || type === "spam_complaint") {
    return { kind: "complaint", email, permanent: true, reason: reason || "complaint" };
  }
  if (type === "delivery" || type === "delivered") return { kind: "delivery", email, permanent: false, reason: "" };
  if (type === "bounce" || type === "hard_bounce" || type === "soft_bounce") {
    const permanent = type === "hard_bounce" ? true : type === "soft_bounce" ? false : item.permanent !== false;
    return { kind: "bounce", email, permanent, reason };
  }
  return null;
}

function parseItem(item: unknown, out: ParsedWebhook, depth: number, options: ParseOptions): void {
  const data = record(item);
  if (!data || depth > 3) {
    out.ignored += 1;
    return;
  }
  const snsType = text(data.Type);
  if (snsType) {
    if (options.verifiedSns && !options.verifiedSns.has(data)) {
      out.unverified += 1;
      return;
    }
    if (snsType === "SubscriptionConfirmation") {
      if (isSnsSubscribeUrl(data.SubscribeURL)) out.confirmUrl = data.SubscribeURL;
      else out.ignored += 1;
    } else if (snsType === "Notification" && typeof data.Message === "string") {
      let inner: unknown = null;
      try {
        inner = JSON.parse(data.Message);
      } catch {
        inner = null;
      }
      parseItem(inner, out, depth + 1, options);
    } else {
      out.ignored += 1;
    }
    return;
  }
  if (data.notificationType || data.eventType) {
    const events = parseSes(data);
    if (events.length === 0) out.ignored += 1;
    out.events.push(...events);
    return;
  }
  if (Array.isArray(data.events)) {
    for (const entry of data.events) parseItem(entry, out, depth + 1, options);
    return;
  }
  const generic = parseGeneric(data);
  if (generic) out.events.push(generic);
  else out.ignored += 1;
}

/** Turns a webhook body (SNS, raw SES, or the generic format; one object or an array) into events. */
export function parseWebhookPayload(body: unknown, options: ParseOptions = {}): ParsedWebhook {
  const out: ParsedWebhook = { events: [], confirmUrl: null, ignored: 0, unverified: 0 };
  const items = Array.isArray(body) ? body : [body];
  for (const item of items.slice(0, MAX_ITEMS)) parseItem(item, out, 0, options);
  return out;
}

const MAX_ITEMS = 1000;

/**
 * Every SNS envelope (an object with a string `Type`) at the places the parser would unwrap one:
 * the body itself, array entries, and `events` entries. The caller verifies each signature, then passes
 * the verified ones back through `ParseOptions.verifiedSns`. Envelopes found inside an SNS `Message`
 * string are never trusted, because SNS does not nest them.
 */
export function findSnsEnvelopes(body: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (item: unknown, depth: number): void => {
    const data = record(item);
    if (!data || depth > 3) return;
    if (text(data.Type)) {
      found.push(data);
      return;
    }
    if (data.notificationType || data.eventType) return;
    if (Array.isArray(data.events)) for (const entry of data.events) visit(entry, depth + 1);
  };
  for (const item of (Array.isArray(body) ? body : [body]).slice(0, MAX_ITEMS)) visit(item, 0);
  return found;
}

export type DeliveryFailure = {
  /** hard_bounce: suppress the address. transient: retry with backoff. permanent: give up without suppressing. */
  kind: "hard_bounce" | "transient" | "permanent";
  message: string;
};

// Permanent refusals that are about the sender, the message, or the server rather than the address.
const NOT_THE_ADDRESS = /spam|block|black ?list|reputation|policy|relay|not verified|unverified|sender|authenticat|quota|\brate\b|\blimit|too large|\bsize\b|dmarc|spf|dkim|suspend|denied/i;

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNECTION",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ESOCKET",
]);

/**
 * Classifies an SMTP/send error for the worker.
 * - hard_bounce: permanent 5xx refusal of this recipient → suppress
 * - transient: 4xx, greylisting, or connection/timeout → retry
 * - permanent: auth/policy/other 5xx that are not the address → fail without suppressing
 */
export function classifyDeliveryError(error: unknown): DeliveryFailure {
  const info = (error ?? {}) as { message?: string; code?: string; responseCode?: number; response?: string; command?: string; errno?: string };
  const message = (info.message || info.response || "Send failed").toString().slice(0, 500);
  const nodemailerCode = String(info.code || info.errno || "").toUpperCase();
  const responseCode = Number(info.responseCode);

  if (TRANSIENT_CODES.has(nodemailerCode) || /timed?\s*out|temporarily|try again|greylist|deferred|resources temporarily/i.test(message)) {
    return { kind: "transient", message };
  }
  if (Number.isFinite(responseCode) && responseCode >= 400 && responseCode < 500) {
    return { kind: "transient", message };
  }
  if (!(responseCode >= 500 && responseCode < 600)) {
    // No SMTP response code and not a known connection error → treat as transient so flaky networks retry.
    if (!Number.isFinite(responseCode) || responseCode === 0) return { kind: "transient", message };
    return { kind: "permanent", message };
  }
  const response = `${info.response ?? ""} ${info.message ?? ""}`;
  const enhanced = response.match(/\b5\.(\d{1,3})\.(\d{1,3})\b/);
  if (enhanced) {
    const subject = Number(enhanced[1]);
    const detail = Number(enhanced[2]);
    // 5.1.x bad destination address; 5.2.1 mailbox disabled; 5.4.1 recipient address rejected.
    const addressProblem = subject === 1 || (subject === 2 && detail === 1) || (subject === 4 && detail === 1);
    if (addressProblem && !NOT_THE_ADDRESS.test(response)) return { kind: "hard_bounce", message };
    return { kind: "permanent", message };
  }
  const refusedRecipient = info.code === "EENVELOPE" || /^RCPT/i.test(info.command ?? "");
  const mailboxCode = responseCode === 550 || responseCode === 551 || responseCode === 553;
  if (refusedRecipient && mailboxCode && !NOT_THE_ADDRESS.test(response)) return { kind: "hard_bounce", message };
  return { kind: "permanent", message };
}
