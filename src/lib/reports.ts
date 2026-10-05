import { toCsv } from "./csv";
import { getAccountSettings } from "./account-settings";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "./send-window";
import { readySql } from "./sql";

// Campaign and automation reports. An automation's mail is stored under its own hidden campaign,
// so one set of queries serves both: pass the campaign id (for an automation, `Automation.campaignId`).
// Same dialect rules as queries.ts: `?` placeholders, Number() around COUNT/SUM, no dialect-only functions.

export type ReportTotals = {
  recipients: number;
  /** Messages the SMTP server accepted (or capture mode stored). */
  sent: number;
  /** Sent plus those the server refused as hard bounces: the base for the bounce rate. */
  attempted: number;
  /** Confirmed delivery reports from the webhook, or null when none have ever arrived. */
  delivered: number | null;
  uniqueOpens: number;
  totalOpens: number;
  uniqueClicks: number;
  totalClicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  failed: number;
  skipped: number;
  waiting: number;
};

export type ReportRates = { open: number; click: number; bounce: number; complaint: number; unsubscribe: number; delivered: number | null };

export type DayPoint = {
  /** Calendar date YYYY-MM-DD in the account timezone. */
  date: string;
  sent: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
};

export type LinkRow = { url: string; clicks: number; people: number };

export type Report = {
  campaignId: string;
  totals: ReportTotals;
  rates: ReportRates;
  days: DayPoint[];
  links: LinkRow[];
};

type Row = Record<string, string | number | null>;

const MAX_DAYS = 90;

function num(value: unknown): number {
  return Number(value ?? 0);
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** 0.1234 -> "12.3%", 0.5 -> "50%", 0.004 -> "0.4%". */
export function formatRate(value: number): string {
  const percent = value * 100;
  if (percent === 0) return "0%";
  const text = percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
  return `${text.replace(/\.0$/, "")}%`;
}

/** Whether a campaign belongs to the account. */
export async function ownsCampaign(userId: string, campaignId: string): Promise<boolean> {
  const sql = await readySql();
  return Boolean(await sql.prepare("SELECT 1 AS found FROM campaigns WHERE id = ? AND user_id = ?").get(campaignId, userId));
}


/** Calendar date YYYY-MM-DD in the given IANA timezone. */
export function dateInTimeZone(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso.slice(0, 10);
  const zone = isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addCalendarDay(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function buildReport(campaignId: string, timezone?: string): Promise<Report> {
  const zone = timezone && isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const sql = await readySql();
  const r = ((await sql
    .prepare(
      `SELECT COUNT(*) AS recipients,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS unique_opens,
         SUM(open_count) AS total_opens,
         SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS unique_clicks,
         SUM(click_count) AS total_clicks
       FROM recipients WHERE campaign_id = ?`,
    )
    .get(campaignId)) ?? {}) as Row;
  const eventRows = (await sql
    .prepare(
      `SELECT type, COUNT(DISTINCT recipient_id) AS n FROM events
       WHERE campaign_id = ? AND type IN ('bounce', 'complaint', 'delivery', 'unsubscribe') GROUP BY type`,
    )
    .all(campaignId)) as Row[];
  const byType = new Map(eventRows.map((row) => [String(row.type), num(row.n)]));

  const sent = num(r.sent);
  const bounces = Math.max(byType.get("bounce") ?? 0, num(r.bounced));
  const attempted = sent + num(r.bounced);
  const deliveredCount = byType.get("delivery") ?? 0;
  const totals: ReportTotals = {
    recipients: num(r.recipients),
    sent,
    attempted,
    delivered: deliveredCount > 0 ? deliveredCount : null,
    uniqueOpens: num(r.unique_opens),
    totalOpens: num(r.total_opens),
    uniqueClicks: num(r.unique_clicks),
    totalClicks: num(r.total_clicks),
    bounces,
    complaints: byType.get("complaint") ?? 0,
    unsubscribes: byType.get("unsubscribe") ?? 0,
    failed: num(r.failed),
    skipped: num(r.skipped),
    waiting: num(r.waiting),
  };
  const rates: ReportRates = {
    open: ratio(totals.uniqueOpens, sent),
    click: ratio(totals.uniqueClicks, sent),
    bounce: ratio(bounces, attempted),
    complaint: ratio(totals.complaints, sent),
    unsubscribe: ratio(totals.unsubscribes, sent),
    delivered: totals.delivered === null ? null : ratio(totals.delivered, sent),
  };

  // Per-day series in the account timezone. Unique opens/clicks use first human open/click.
  const perDay = new Map<string, DayPoint>();
  const point = (date: string): DayPoint => {
    let entry = perDay.get(date);
    if (!entry) {
      entry = { date, sent: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 };
      perDay.set(date, entry);
    }
    return entry;
  };
  const bump = (iso: string | null | undefined, apply: (entry: DayPoint) => void) => {
    if (!iso) return;
    apply(point(dateInTimeZone(String(iso), zone)));
  };
  for (const row of (await sql
    .prepare("SELECT sent_at FROM recipients WHERE campaign_id = ? AND status = 'sent' AND sent_at IS NOT NULL")
    .all(campaignId)) as Row[]) {
    bump(row.sent_at as string, (entry) => (entry.sent += 1));
  }
  for (const row of (await sql
    .prepare("SELECT opened_at FROM recipients WHERE campaign_id = ? AND opened_at IS NOT NULL")
    .all(campaignId)) as Row[]) {
    bump(row.opened_at as string, (entry) => (entry.opens += 1));
  }
  for (const row of (await sql
    .prepare("SELECT clicked_at FROM recipients WHERE campaign_id = ? AND clicked_at IS NOT NULL")
    .all(campaignId)) as Row[]) {
    bump(row.clicked_at as string, (entry) => (entry.clicks += 1));
  }
  for (const row of (await sql
    .prepare(
      `SELECT created_at, type FROM events
       WHERE campaign_id = ? AND type IN ('bounce', 'complaint', 'unsubscribe')`,
    )
    .all(campaignId)) as Row[]) {
    bump(row.created_at as string, (entry) => {
      if (row.type === "bounce") entry.bounces += 1;
      else if (row.type === "complaint") entry.complaints += 1;
      else entry.unsubscribes += 1;
    });
  }
  const dates = [...perDay.keys()].sort();
  const days: DayPoint[] = [];
  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    let day = dates[0];
    const first = addCalendarDay(last, -(MAX_DAYS - 1));
    if (day < first) day = first;
    for (; day <= last; day = addCalendarDay(day, 1)) days.push(perDay.get(day) ?? point(day));
  }

  const linkRows = (await sql
    .prepare(
      `SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT recipient_id) AS people FROM events
       WHERE campaign_id = ? AND type = 'click' AND url != '' AND bot = 0
       GROUP BY url ORDER BY clicks DESC, url LIMIT 10`,
    )
    .all(campaignId)) as Row[];
  const links = linkRows.map((row) => ({ url: String(row.url), clicks: num(row.clicks), people: num(row.people) }));
  return { campaignId, totals, rates, days, links };
}

export type ReportKind = "summary" | "daily" | "links" | "recipients";

export function isReportKind(value: string | null): value is ReportKind {
  return value === "summary" || value === "daily" || value === "links" || value === "recipients";
}

/** One row per recipient, for follow-up in a spreadsheet. */
async function recipientsCsv(campaignId: string): Promise<string> {
  const sql = await readySql();
  const rows = (await sql
    .prepare(
      `SELECT r.email, r.status, r.sent_at, r.opened_at, r.clicked_at, r.open_count, r.click_count, r.error,
         (SELECT COUNT(*) FROM events e WHERE e.recipient_id = r.id AND e.type = 'bounce') AS bounced,
         (SELECT COUNT(*) FROM events e WHERE e.recipient_id = r.id AND e.type = 'complaint') AS complained,
         (SELECT COUNT(*) FROM events e WHERE e.recipient_id = r.id AND e.type = 'unsubscribe') AS unsubscribed
       FROM recipients r WHERE r.campaign_id = ? ORDER BY r.email`,
    )
    .all(campaignId)) as Row[];
  const yes = (value: unknown) => (num(value) > 0 ? "yes" : "no");
  return toCsv([
    ["email", "status", "sent_at", "first_opened_at", "first_clicked_at", "opens", "clicks", "bounced", "complained", "unsubscribed", "error"],
    ...rows.map((row) => [
      String(row.email),
      String(row.status),
      String(row.sent_at ?? ""),
      String(row.opened_at ?? ""),
      String(row.clicked_at ?? ""),
      String(num(row.open_count)),
      String(num(row.click_count)),
      yes(row.bounced),
      yes(row.complained),
      yes(row.unsubscribed),
      String(row.error ?? ""),
    ]),
  ]);
}

/** CSV for one part of a report. */
export async function reportCsv(report: Report, kind: ReportKind): Promise<string> {
  const { totals, rates } = report;
  const rate = (value: number | null) => (value === null ? "" : formatRate(value));
  if (kind === "daily") {
    return toCsv([
      ["date", "sent", "unique_opens", "unique_clicks", "bounces", "complaints", "unsubscribes"],
      ...report.days.map((day) => [day.date, day.sent, day.opens, day.clicks, day.bounces, day.complaints, day.unsubscribes].map(String)),
    ]);
  }
  if (kind === "links") {
    return toCsv([["url", "clicks", "people"], ...report.links.map((link) => [link.url, String(link.clicks), String(link.people)])]);
  }
  if (kind === "recipients") return recipientsCsv(report.campaignId);
  return toCsv([
    ["metric", "count", "rate"],
    ["recipients", String(totals.recipients), ""],
    ["sent", String(totals.sent), ""],
    ["delivered (reported by webhook)", totals.delivered === null ? "" : String(totals.delivered), rate(rates.delivered)],
    ["unique opens", String(totals.uniqueOpens), rate(rates.open)],
    ["total opens", String(totals.totalOpens), ""],
    ["unique clicks", String(totals.uniqueClicks), rate(rates.click)],
    ["total clicks", String(totals.totalClicks), ""],
    ["bounces", String(totals.bounces), rate(rates.bounce)],
    ["complaints", String(totals.complaints), rate(rates.complaint)],
    ["unsubscribes", String(totals.unsubscribes), rate(rates.unsubscribe)],
    ["failed", String(totals.failed), ""],
    ["skipped", String(totals.skipped), ""],
    ["waiting", String(totals.waiting), ""],
  ]);
}

/** Builds a report using the account timezone from Settings. */
export async function buildReportForUser(userId: string, campaignId: string): Promise<Report> {
  const settings = await getAccountSettings(userId);
  return buildReport(campaignId, settings.timezone);
}
