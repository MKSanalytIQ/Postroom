export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function addMinutesIso(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60 * 1000).toISOString();
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function percent(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}
