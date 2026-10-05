import { hostname } from "os";
import { readySql } from "./sql";
import { nowIso } from "./time";

export function defaultWorkerId(): string {
  return process.env.WORKER_ID?.trim() || `worker:${hostname()}:${process.pid}`;
}

export async function touchWorkerHeartbeat(detail = "", workerId = defaultWorkerId()): Promise<void> {
  const sql = await readySql();
  await sql
    .prepare(
      `INSERT INTO worker_heartbeats (worker_id, last_seen_at, detail) VALUES (?, ?, ?)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, detail = excluded.detail`,
    )
    .run(workerId.slice(0, 120), nowIso(), detail.slice(0, 300));
}

export type WorkerHeartbeat = { workerId: string; lastSeenAt: string; detail: string; stale: boolean };

export async function listWorkerHeartbeats(staleAfterMs = 5 * 60_000): Promise<WorkerHeartbeat[]> {
  const sql = await readySql();
  const rows = (await sql
    .prepare("SELECT worker_id, last_seen_at, detail FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20")
    .all()) as { worker_id: string; last_seen_at: string; detail: string }[];
  const cutoff = Date.now() - staleAfterMs;
  return rows.map((row) => ({
    workerId: row.worker_id,
    lastSeenAt: row.last_seen_at,
    detail: row.detail,
    stale: Date.parse(row.last_seen_at) < cutoff,
  }));
}

export async function latestWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  const list = await listWorkerHeartbeats();
  return list[0] ?? null;
}
