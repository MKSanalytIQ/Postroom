process.env.POSTROOM_WORKER = "1";

import { log, reportError } from "../src/lib/log";
import { runWorkerCycle } from "../src/lib/worker-cycle";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log.info("worker_started");
  for (;;) {
    try {
      const work = await runWorkerCycle(5);
      await sleep(work === 0 ? 2000 : 50);
    } catch (error) {
      await reportError(error, { component: "worker" });
      await sleep(3000);
    }
  }
}

void main();
