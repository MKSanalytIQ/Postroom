import { latestWorkerHeartbeat } from "@/lib/heartbeat";
import { readySql } from "@/lib/sql";

export const runtime = "nodejs";

export async function GET() {
  const started = Date.now();
  try {
    const sql = await readySql();
    await sql.prepare("SELECT 1 AS ok").get();
    const worker = await latestWorkerHeartbeat();
    return Response.json({
      ok: true,
      db: sql.dialect,
      latencyMs: Date.now() - started,
      worker: worker
        ? { id: worker.workerId, lastSeenAt: worker.lastSeenAt, stale: worker.stale, detail: worker.detail }
        : null,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "health check failed",
        latencyMs: Date.now() - started,
      },
      { status: 503 },
    );
  }
}
