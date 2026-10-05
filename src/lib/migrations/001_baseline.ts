import type { Migration } from "./types";

/**
 * Baseline stamp only. The portable CREATE IF NOT EXISTS schema in schema.ts
 * is applied before migrations run, so existing and empty databases already have
 * the pre-polish tables. This migration records that fact.
 */
export const migration001Baseline: Migration = {
  id: "001_baseline",
  async up() {
    // no-op: schema.ts already applied
  },
};
