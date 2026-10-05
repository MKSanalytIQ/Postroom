declare module "@sentry/node" {
  export function init(options: { dsn: string; tracesSampleRate?: number }): void;
  export function captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): void;
}
