/** Heuristics for link scanners / prefetch bots that inflate opens and clicks. */

export type TrackMeta = {
  userAgent?: string;
  method?: string;
  /** ISO time the message was sent, if known. */
  sentAt?: string | null;
  /** Other click URLs recorded for this recipient in the last ~1s (excluding the current one). */
  recentClickUrls?: string[];
  url?: string;
  now?: Date;
};

const SCANNER_UA = [
  /proofpoint/i,
  /barracuda/i,
  /mimecast/i,
  /messagelabs/i,
  /trend micro/i,
  /mailscanner/i,
  /symantec/i,
  /googleimageproxy/i,
  /yahoo mail proxy/i,
  /facebookexternalhit/i,
  /slackbot/i,
  /twitterbot/i,
  /linkedinbot/i,
  /applebot/i,
  /bingbot/i,
  /yandex/i,
  /spider/i,
  /crawler/i,
  /bot\b/i,
  /preview/i,
  /urlscan/i,
  /safelinks/i,
  /defender/i,
];

/** Seconds after send during which opens/clicks are treated as scanners. */
export const SCANNER_IMMEDIATE_SECONDS = 5;

export function scannerImmediateSeconds(): number {
  const n = Number(process.env.POSTROOM_SCANNER_IMMEDIATE_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n : SCANNER_IMMEDIATE_SECONDS;
}

export function isScannerUserAgent(ua: string | undefined): boolean {
  if (!ua || !ua.trim()) return false;
  return SCANNER_UA.some((re) => re.test(ua));
}

export function classifyTracking(meta: TrackMeta): { bot: boolean; reason: string } {
  const method = (meta.method || "GET").toUpperCase();
  if (method === "HEAD") return { bot: true, reason: "head" };
  if (isScannerUserAgent(meta.userAgent)) return { bot: true, reason: "user-agent" };

  const now = meta.now ?? new Date();
  if (meta.sentAt) {
    const sent = Date.parse(meta.sentAt);
    if (Number.isFinite(sent) && now.getTime() - sent < scannerImmediateSeconds() * 1000) {
      return { bot: true, reason: "too-soon" };
    }
  }

  const url = meta.url || "";
  const recent = meta.recentClickUrls || [];
  if (url && recent.some((other) => other && other !== url)) {
    return { bot: true, reason: "multi-link" };
  }

  return { bot: false, reason: "" };
}
