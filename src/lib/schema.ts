// Shared by SQLite (local fallback) and Postgres, so keep it to portable DDL:
// TEXT/INTEGER columns, ISO-8601 timestamps stored as TEXT, no AUTOINCREMENT or
// dialect-specific defaults, and no semicolons inside statements.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  reply_to TEXT NOT NULL DEFAULT '',
  smtp_host TEXT NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT NOT NULL DEFAULT '',
  smtp_pass TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'subscribed',
  unsub_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, email)
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  reply_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  origin TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  unsub_token TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL UNIQUE REFERENCES recipients(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppressions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  origin TEXT NOT NULL DEFAULT '',
  trigger_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_steps (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  current_step INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  stop_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(automation_id, contact_id)
);

CREATE TABLE IF NOT EXISTS automation_sends (
  enrollment_id TEXT NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES automation_steps(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL UNIQUE REFERENCES recipients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (enrollment_id, step_id)
);

-- Optional automation rules, one row per automation. No row means the defaults: no exit conditions and no send window.
-- Kept in its own table so existing databases only need this CREATE TABLE IF NOT EXISTS, never an ALTER.
CREATE TABLE IF NOT EXISTS automation_settings (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  exit_on_click INTEGER NOT NULL DEFAULT 0,
  exit_list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  window_enabled INTEGER NOT NULL DEFAULT 0,
  window_days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  window_start_hour INTEGER NOT NULL DEFAULT 0,
  window_end_hour INTEGER NOT NULL DEFAULT 24,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TEXT NOT NULL
);

-- Addresses that must never be mailed again: hard bounces, spam complaints, and ones added by hand.
CREATE TABLE IF NOT EXISTS suppressed_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(user_id, email)
);

-- Per-account deliverability settings in their own table, so existing databases need no ALTER.
CREATE TABLE IF NOT EXISTS deliverability_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  webhook_token TEXT UNIQUE,
  dkim_selector TEXT NOT NULL DEFAULT 'default',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);

-- Send retries: attempt count and when the recipient may be claimed again (additive; recipients table unchanged).
CREATE TABLE IF NOT EXISTS recipient_attempts (
  recipient_id TEXT PRIMARY KEY REFERENCES recipients(id) ON DELETE CASCADE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_recipient_attempts_due ON recipient_attempts(next_attempt_at);

-- Password reset tokens (SHA-256 hash of the secret; single-use, short-lived).
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- Per-contact consent (source, when, optional double opt-in confirmation).
CREATE TABLE IF NOT EXISTS contact_consent (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  confirmed_at TEXT,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

-- Public subscribe forms and double opt-in settings per list (additive).
CREATE TABLE IF NOT EXISTS list_settings (
  list_id TEXT PRIMARY KEY REFERENCES lists(id) ON DELETE CASCADE,
  public_token TEXT NOT NULL UNIQUE,
  double_opt_in INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Pending confirmation tokens for public subscribe (double opt-in).
CREATE TABLE IF NOT EXISTS subscribe_confirmations (
  token_hash TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_recipients_pending ON recipients(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id, type);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_automation_steps_order ON automation_steps(automation_id, position);
CREATE INDEX IF NOT EXISTS idx_enrollments_due ON automation_enrollments(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_contact ON automation_enrollments(contact_id);
-- Bounce webhook tokens, stored only as a SHA-256 hash (the plaintext is shown once, when it is created).
-- hint is the last four characters, so Settings can say which token is active. The older plaintext
-- column deliverability_settings.webhook_token is emptied the first time it is used after an upgrade.
CREATE TABLE IF NOT EXISTS webhook_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppressed_user ON suppressed_addresses(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_recipient ON events(recipient_id, type);
`;
