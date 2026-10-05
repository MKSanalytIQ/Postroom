import { closeSql, readySql } from "../src/lib/sql";
import { migrationStatus, runMigrations } from "../src/lib/migrations";

async function main() {
  const sql = await readySql();
  const before = await migrationStatus(sql);
  console.log("Pending:", before.pending.length ? before.pending.join(", ") : "(none)");
  const result = await runMigrations(sql);
  if (result.applied.length) console.log("Applied:", result.applied.join(", "));
  else console.log("Applied: (none)");
  const after = await migrationStatus(sql);
  console.log("Current:");
  for (const row of after.applied) console.log(`  ${row.id} @ ${row.appliedAt}`);
  await closeSql();
}

main().catch(async (error) => {
  console.error(error);
  await closeSql().catch(() => {});
  process.exit(1);
});
