type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...sanitize(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (/(password|secret|token|authorization|smtp_pass|smtpPass)/i.test(lower) && typeof value === "string") {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 2000) out[key] = `${value.slice(0, 2000)}…`;
    else out[key] = value;
  }
  return out;
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

/**
 * Optional Sentry-compatible hook. Set SENTRY_DSN and optionally install @sentry/node yourself;
 * when the package is absent or DSN unset, this is a no-op beyond structured logging.
 */
let sentryTried = false;
let sentryCapture: ((error: unknown, ctx?: LogFields) => void) | null = null;

async function loadSentry(): Promise<void> {
  if (sentryTried) return;
  sentryTried = true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  try {
    // Dynamic import so the dependency stays optional.
    const mod = (await import("@sentry/node").catch(() => null)) as null | {
      init?: (opts: { dsn: string; tracesSampleRate?: number }) => void;
      captureException?: (error: unknown, hint?: { extra?: LogFields }) => void;
    };
    if (!mod?.init || !mod.captureException) {
      log.warn("SENTRY_DSN is set but @sentry/node is not installed; errors are logged only");
      return;
    }
    mod.init({ dsn, tracesSampleRate: 0 });
    sentryCapture = (error, ctx) => mod.captureException!(error, ctx ? { extra: ctx } : undefined);
    log.info("sentry_initialized");
  } catch (error) {
    log.warn("sentry_init_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function reportError(error: unknown, fields: LogFields = {}): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  log.error(message, { ...fields, stack });
  await loadSentry();
  try {
    sentryCapture?.(error, fields);
  } catch {
    // never throw from the error reporter
  }
}
