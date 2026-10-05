import nodemailer from "nodemailer";

export type SystemMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type SystemMailResult = { mode: "smtp" | "console"; messageId?: string };

/** App-level SMTP for password reset and double opt-in mail (not the per-account campaign SMTP). */
export function systemSmtpConfigured(): boolean {
  return Boolean(process.env.SYSTEM_SMTP_HOST?.trim());
}

function systemTransport() {
  const host = process.env.SYSTEM_SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SYSTEM_SMTP_PORT || 587);
  const secure = process.env.SYSTEM_SMTP_SECURE === "1" || process.env.SYSTEM_SMTP_SECURE === "true" || port === 465;
  const user = process.env.SYSTEM_SMTP_USER?.trim() || "";
  const pass = process.env.SYSTEM_SMTP_PASS ?? "";
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
}

function systemFrom(): string {
  return (process.env.SYSTEM_SMTP_FROM?.trim() || process.env.SYSTEM_SMTP_USER?.trim() || "postroom@localhost").slice(0, 200);
}

/**
 * Sends a system message. When SYSTEM_SMTP_HOST is unset, logs to the console (dev / capture)
 * and still reports success so callers do not leak whether an account exists.
 */
export async function sendSystemMail(mail: SystemMail): Promise<SystemMailResult> {
  const client = systemTransport();
  if (!client) {
    console.log(
      `[postroom:system-mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}\n`,
    );
    return { mode: "console" };
  }
  try {
    const info = await client.sendMail({
      from: systemFrom(),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { mode: "smtp", messageId: String(info.messageId || "") };
  } finally {
    client.close();
  }
}
