"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";

export function Flash({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <p className="banner bad">{error}</p>;
  if (notice) return <p className="banner good">{notice}</p>;
  return null;
}

export function PageHeader({
  title,
  lede,
  action,
}: {
  title: string;
  lede?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="muted">{lede}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Pill({ status }: { status: string }) {
  const tone =
    status === "sent" || status === "subscribed" || status === "active" || status === "completed"
      ? "good"
      : status === "failed" || status === "unsubscribed"
        ? "bad"
        : status === "sending" || status === "paused" || status === "stopped"
          ? "warn"
          : "";
  return <span className={`pill ${tone}`}>{status}</span>;
}

export function SubmitButton({
  children,
  className = "btn btn-primary",
  pendingLabel = "Working…",
  formAction,
}: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} formAction={formAction}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export function ConfirmSubmit({
  label,
  message,
  className = "btn btn-ghost",
}: {
  label: string;
  message: string;
  className?: string;
}) {
  return (
    <button
      className={className}
      type="submit"
      onClick={(event) => {
        if (!confirm(message)) event.preventDefault();
      }}
    >
      {label}
    </button>
  );
}

export function Pager({
  path,
  page,
  total,
  pageSize,
  query = "",
}: {
  path: string;
  page: number;
  total: number;
  pageSize: number;
  query?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const link = (n: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (n > 1) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };
  return (
    <div className="pager">
      {page > 1 ? <Link href={link(page - 1)}>Previous</Link> : <span />}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? <Link href={link(page + 1)}>Next</Link> : <span />}
    </div>
  );
}
