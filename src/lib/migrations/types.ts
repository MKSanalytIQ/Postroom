import type { Sql } from "../sql";

export type Migration = {
  /** Stable id, e.g. "002_email_verification". Applied once, in order. */
  id: string;
  up: (sql: Sql) => Promise<void>;
};
