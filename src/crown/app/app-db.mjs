import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { APP_CONTRACT_VERSION } from './app-contract-version.mjs'
import { decideAlertBettingMigration } from './alert-betting-settings-migration.mjs'
import { canonicalAutoBettingDecimal } from '../betting/auto-betting-settings.mjs'
import { migrateFixedSettingsToRuleCards } from '../betting/dynamic-card-migration.mjs'
import { assertPathWithin } from '../runtime/portable-paths.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'

const INBOX_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_append_only_delete
BEFORE DELETE ON auto_betting_signal_inbox
BEGIN
  SELECT RAISE(ABORT, 'auto-betting-inbox-append-only');
END`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracked_matches (
  event_key TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  mode TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT '',
  tracking_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  login_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disabled',
  enabled INTEGER NOT NULL DEFAULT 0,
  login_status TEXT NOT NULL DEFAULT '未启动',
  current_monitor_status TEXT NOT NULL DEFAULT '未启动',
  last_login_at TEXT NOT NULL DEFAULT '',
  last_online_check_at TEXT NOT NULL DEFAULT '',
  last_xml_response_at TEXT NOT NULL DEFAULT '',
  last_odds_parsed_at TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  odds_scan_interval_seconds INTEGER NOT NULL DEFAULT 10,
  auto_relogin_count INTEGER NOT NULL DEFAULT 0,
  max_auto_relogin_count INTEGER NOT NULL DEFAULT 3,
  last_login_result_json TEXT NOT NULL DEFAULT '{}',
  last_login_result_at TEXT NOT NULL DEFAULT '',
  last_login_diagnostics_path TEXT NOT NULL DEFAULT '',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  secret_updated_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  league_filter TEXT NOT NULL DEFAULT '',
  mode_filter TEXT NOT NULL DEFAULT '',
  market_filter TEXT NOT NULL DEFAULT '',
  min_odds_change REAL NOT NULL DEFAULT 0.03,
  poll_seconds INTEGER NOT NULL DEFAULT 5,
  alert_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_alert_settings (
  mode TEXT PRIMARY KEY CHECK (mode IN ('prematch','live')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  asian_handicap_enabled INTEGER NOT NULL DEFAULT 0 CHECK (asian_handicap_enabled IN (0,1)),
  total_enabled INTEGER NOT NULL DEFAULT 0 CHECK (total_enabled IN (0,1)),
  monitor_odds_min REAL
    CHECK (monitor_odds_min IS NULL OR (typeof(monitor_odds_min) IN ('integer','real') AND monitor_odds_min BETWEEN -9007199254740991 AND 9007199254740991)),
  monitor_odds_max REAL
    CHECK (monitor_odds_max IS NULL OR (typeof(monitor_odds_max) IN ('integer','real') AND monitor_odds_max BETWEEN -9007199254740991 AND 9007199254740991)),
  water_move_threshold REAL
    CHECK (water_move_threshold IS NULL OR (typeof(water_move_threshold) IN ('integer','real') AND water_move_threshold BETWEEN 0 AND 9007199254740991)),
  cooldown_seconds INTEGER
    CHECK (cooldown_seconds IS NULL OR (typeof(cooldown_seconds) = 'integer' AND cooldown_seconds BETWEEN 0 AND 9007199254740991)),
  start_minutes_before_kickoff INTEGER
    CHECK (start_minutes_before_kickoff IS NULL OR (typeof(start_minutes_before_kickoff) = 'integer' AND start_minutes_before_kickoff BETWEEN 0 AND 9007199254740991)),
  stop_minutes_before_kickoff INTEGER
    CHECK (stop_minutes_before_kickoff IS NULL OR (typeof(stop_minutes_before_kickoff) = 'integer' AND stop_minutes_before_kickoff BETWEEN 0 AND 9007199254740991)),
  live_minute_from INTEGER
    CHECK (live_minute_from IS NULL OR (typeof(live_minute_from) = 'integer' AND live_minute_from BETWEEN 0 AND 9007199254740991)),
  live_minute_to INTEGER
    CHECK (live_minute_to IS NULL OR (typeof(live_minute_to) = 'integer' AND live_minute_to BETWEEN 0 AND 9007199254740991)),
  include_first_half INTEGER NOT NULL DEFAULT 0 CHECK (include_first_half IN (0,1)),
  include_half_time INTEGER NOT NULL DEFAULT 0 CHECK (include_half_time IN (0,1)),
  include_second_half INTEGER NOT NULL DEFAULT 0 CHECK (include_second_half IN (0,1)),
  remark TEXT NOT NULL DEFAULT '',
  migration_review_required INTEGER NOT NULL DEFAULT 1 CHECK (migration_review_required IN (0,1)),
  migration_review_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (monitor_odds_min IS NULL OR monitor_odds_max IS NULL OR monitor_odds_min <= monitor_odds_max),
  CHECK (mode = 'prematch' OR (start_minutes_before_kickoff IS NULL AND stop_minutes_before_kickoff IS NULL)),
  CHECK (mode = 'live' OR (live_minute_from IS NULL AND live_minute_to IS NULL AND include_first_half = 0 AND include_half_time = 0 AND include_second_half = 0)),
  CHECK (mode = 'live' OR start_minutes_before_kickoff IS NULL OR stop_minutes_before_kickoff IS NULL OR start_minutes_before_kickoff >= stop_minutes_before_kickoff),
  CHECK (mode = 'prematch' OR live_minute_from IS NULL OR live_minute_to IS NULL OR live_minute_from <= live_minute_to),
  CHECK (enabled = 0 OR (migration_review_required = 0 AND (asian_handicap_enabled = 1 OR total_enabled = 1)))
);

CREATE TABLE IF NOT EXISTS auto_betting_settings (
  mode TEXT PRIMARY KEY CHECK (mode IN ('prematch','live')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  target_odds_min TEXT CHECK (target_odds_min IS NULL OR (
    typeof(target_odds_min) = 'text'
    AND length(target_odds_min) BETWEEN 1 AND 128
    AND target_odds_min NOT GLOB '*[^0-9.]*'
    AND target_odds_min NOT LIKE '%.%.%'
    AND target_odds_min NOT LIKE '.%'
    AND target_odds_min NOT LIKE '%.'
    AND (target_odds_min = '0' OR target_odds_min GLOB '[1-9]*' OR target_odds_min GLOB '0.[0-9]*')
    AND (instr(target_odds_min, '.') = 0 OR substr(target_odds_min, -1) GLOB '[1-9]')
    AND (instr(target_odds_min, '.') = 0 OR length(target_odds_min) - instr(target_odds_min, '.') <= 18)
    AND (
      length(CASE WHEN instr(target_odds_min, '.') = 0 THEN target_odds_min ELSE substr(target_odds_min, 1, instr(target_odds_min, '.') - 1) END) < 16
      OR (length(CASE WHEN instr(target_odds_min, '.') = 0 THEN target_odds_min ELSE substr(target_odds_min, 1, instr(target_odds_min, '.') - 1) END) = 16
        AND CASE WHEN instr(target_odds_min, '.') = 0 THEN target_odds_min ELSE substr(target_odds_min, 1, instr(target_odds_min, '.') - 1) END < '9007199254740991')
      OR (target_odds_min = '9007199254740991')
    )
  )),
  target_odds_max TEXT CHECK (target_odds_max IS NULL OR (
    typeof(target_odds_max) = 'text'
    AND length(target_odds_max) BETWEEN 1 AND 128
    AND target_odds_max NOT GLOB '*[^0-9.]*'
    AND target_odds_max NOT LIKE '%.%.%'
    AND target_odds_max NOT LIKE '.%'
    AND target_odds_max NOT LIKE '%.'
    AND (target_odds_max = '0' OR target_odds_max GLOB '[1-9]*' OR target_odds_max GLOB '0.[0-9]*')
    AND (instr(target_odds_max, '.') = 0 OR substr(target_odds_max, -1) GLOB '[1-9]')
    AND (instr(target_odds_max, '.') = 0 OR length(target_odds_max) - instr(target_odds_max, '.') <= 18)
    AND (
      length(CASE WHEN instr(target_odds_max, '.') = 0 THEN target_odds_max ELSE substr(target_odds_max, 1, instr(target_odds_max, '.') - 1) END) < 16
      OR (length(CASE WHEN instr(target_odds_max, '.') = 0 THEN target_odds_max ELSE substr(target_odds_max, 1, instr(target_odds_max, '.') - 1) END) = 16
        AND CASE WHEN instr(target_odds_max, '.') = 0 THEN target_odds_max ELSE substr(target_odds_max, 1, instr(target_odds_max, '.') - 1) END < '9007199254740991')
      OR (target_odds_max = '9007199254740991')
    )
  )),
  target_amount_minor INTEGER
    CHECK (target_amount_minor IS NULL OR (typeof(target_amount_minor) = 'integer' AND target_amount_minor BETWEEN 1 AND 9007199254740991)),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  amount_scale INTEGER NOT NULL DEFAULT 0 CHECK (typeof(amount_scale) = 'integer' AND amount_scale = 0),
  remark TEXT NOT NULL DEFAULT '',
  real_eligible INTEGER NOT NULL DEFAULT 0 CHECK (real_eligible IN (0,1)),
  real_eligibility_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(real_eligibility_version) = 'integer' AND real_eligibility_version >= 1),
  real_eligibility_updated_at TEXT NOT NULL DEFAULT '',
  migration_review_required INTEGER NOT NULL DEFAULT 1 CHECK (migration_review_required IN (0,1)),
  migration_review_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (target_odds_min IS NULL OR target_odds_max IS NULL OR (
    replace(printf('%16s', CASE WHEN instr(target_odds_min, '.') = 0 THEN target_odds_min ELSE substr(target_odds_min, 1, instr(target_odds_min, '.') - 1) END), ' ', '0')
      || substr(CASE WHEN instr(target_odds_min, '.') = 0 THEN '' ELSE substr(target_odds_min, instr(target_odds_min, '.') + 1) END || '000000000000000000', 1, 18)
    <=
    replace(printf('%16s', CASE WHEN instr(target_odds_max, '.') = 0 THEN target_odds_max ELSE substr(target_odds_max, 1, instr(target_odds_max, '.') - 1) END), ' ', '0')
      || substr(CASE WHEN instr(target_odds_max, '.') = 0 THEN '' ELSE substr(target_odds_max, instr(target_odds_max, '.') + 1) END || '000000000000000000', 1, 18)
  )),
  CHECK (enabled = 0 OR (migration_review_required = 0 AND target_odds_min IS NOT NULL AND target_odds_max IS NOT NULL AND target_amount_minor IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS auto_betting_rule_cards (
  card_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  target_odds_min TEXT,
  target_odds_max TEXT,
  target_amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  amount_scale INTEGER NOT NULL DEFAULT 0 CHECK (amount_scale = 0),
  remark TEXT NOT NULL DEFAULT '',
  real_eligible INTEGER NOT NULL DEFAULT 0 CHECK (real_eligible IN (0,1)),
  real_eligibility_version INTEGER NOT NULL DEFAULT 1 CHECK (real_eligibility_version >= 1),
  real_eligibility_updated_at TEXT NOT NULL,
  migration_review_required INTEGER NOT NULL DEFAULT 0 CHECK (migration_review_required IN (0,1)),
  migration_review_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (migration_review_required = 1 OR (
    target_odds_min IS NOT NULL
    AND target_odds_max IS NOT NULL
    AND typeof(target_amount_minor) = 'integer'
    AND target_amount_minor BETWEEN 1 AND 9007199254740991
  ))
);

CREATE TABLE IF NOT EXISTS auto_betting_rule_card_leagues (
  card_id TEXT NOT NULL REFERENCES auto_betting_rule_cards(card_id) ON DELETE CASCADE,
  league_name TEXT NOT NULL UNIQUE CHECK (trim(league_name) <> ''),
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, league_name)
);

CREATE TABLE IF NOT EXISTS app_schema_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_betting_signal_inbox (
  signal_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  card_version INTEGER NOT NULL
    CHECK (typeof(card_version) = 'integer' AND card_version >= 1),
  card_snapshot_json TEXT NOT NULL
    CHECK (json_valid(card_snapshot_json) AND json_type(card_snapshot_json) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('prematch','live')),
  settings_version INTEGER NOT NULL CHECK (typeof(settings_version) = 'integer' AND settings_version >= 1),
  settings_snapshot_json TEXT NOT NULL CHECK (json_valid(settings_snapshot_json) AND json_type(settings_snapshot_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','skipped','batch_created','dead_letter')),
  skip_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT '',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, card_id),
  CHECK (
    (status = 'processing' AND trim(lease_owner) <> '' AND trim(lease_expires_at) <> '')
    OR (status <> 'processing' AND lease_owner = '' AND lease_expires_at = '')
  ),
  CHECK (
    (status = 'batch_created' AND batch_id IS NOT NULL AND trim(batch_id) <> '')
    OR (status <> 'batch_created' AND batch_id IS NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_settings_immutable
BEFORE UPDATE OF mode, settings_version, settings_snapshot_json ON auto_betting_signal_inbox
WHEN NEW.mode IS NOT OLD.mode
  OR NEW.settings_version IS NOT OLD.settings_version
  OR NEW.settings_snapshot_json IS NOT OLD.settings_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'auto-betting-inbox-settings-immutable');
END;

CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_state_safe_insert
BEFORE INSERT ON auto_betting_signal_inbox
WHEN NOT (
  ((NEW.status = 'processing' AND trim(NEW.lease_owner) <> '' AND trim(NEW.lease_expires_at) <> '')
    OR (NEW.status <> 'processing' AND NEW.lease_owner = '' AND NEW.lease_expires_at = ''))
  AND ((NEW.status = 'batch_created' AND NEW.batch_id IS NOT NULL AND trim(NEW.batch_id) <> '')
    OR (NEW.status <> 'batch_created' AND NEW.batch_id IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'auto-betting-inbox-state-lease-batch-constraint');
END;

CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_state_safe_update
BEFORE UPDATE ON auto_betting_signal_inbox
WHEN NOT (
  ((NEW.status = 'processing' AND trim(NEW.lease_owner) <> '' AND trim(NEW.lease_expires_at) <> '')
    OR (NEW.status <> 'processing' AND NEW.lease_owner = '' AND NEW.lease_expires_at = ''))
  AND ((NEW.status = 'batch_created' AND NEW.batch_id IS NOT NULL AND trim(NEW.batch_id) <> '')
    OR (NEW.status <> 'batch_created' AND NEW.batch_id IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'auto-betting-inbox-state-lease-batch-constraint');
END;

${INBOX_DELETE_TRIGGER};

CREATE TABLE IF NOT EXISTS betting_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  monitor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitor_enabled IN (0,1)),
  real_betting_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_betting_enabled IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  mode TEXT NOT NULL DEFAULT 'prematch' CHECK (mode IN ('prematch','live')),
  period TEXT NOT NULL DEFAULT 'full' CHECK (period IN ('full','first_half','second_half')),
  per_account_bet_amount REAL NOT NULL DEFAULT 0,
  per_account_daily_limit REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  market_type TEXT NOT NULL DEFAULT 'asian_handicap' CHECK (market_type IN ('asian_handicap','total')),
  monitored_side TEXT NOT NULL DEFAULT 'home' CHECK (monitored_side IN ('home','away','over','under')),
  min_water_rise TEXT NOT NULL DEFAULT '0.01',
  target_odds_min TEXT NOT NULL DEFAULT '0',
  target_odds_max TEXT NOT NULL DEFAULT '2',
  start_minutes_before_kickoff INTEGER,
  stop_minutes_before_kickoff INTEGER,
  live_minute_from INTEGER,
  live_minute_to INTEGER,
  min_odds REAL,
  max_odds REAL,
  bet_direction_mode TEXT NOT NULL DEFAULT 'auto',
  max_single_amount REAL NOT NULL DEFAULT 0,
  max_event_amount REAL NOT NULL DEFAULT 0,
  stop_loss_amount REAL NOT NULL DEFAULT 0,
  preview_only INTEGER NOT NULL DEFAULT 1,
  execution_mode TEXT NOT NULL DEFAULT 'preview_only'
    CHECK (execution_mode IN ('preview_only', 'real_eligible')),
  currency TEXT NOT NULL DEFAULT 'CNY',
  amount_scale INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6),
  target_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(target_amount_minor) = 'integer' AND target_amount_minor >= 0 AND target_amount_minor <= 9007199254740991),
  league_names_json TEXT NOT NULL DEFAULT '[]',
  changed_odds_min REAL,
  changed_odds_max REAL,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  migration_review_required INTEGER NOT NULL DEFAULT 0 CHECK (migration_review_required IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  website_url TEXT NOT NULL DEFAULT '',
  bet_order INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'manual_review',
  status TEXT NOT NULL DEFAULT 'disabled',
  daily_limit REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  allocation_status TEXT NOT NULL DEFAULT 'paused'
    CHECK (allocation_status IN ('enabled', 'pause_pending', 'paused', 'checking')),
  per_bet_limit_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(per_bet_limit_minor) = 'integer' AND per_bet_limit_minor >= 0 AND per_bet_limit_minor <= 9007199254740991),
  currency TEXT NOT NULL DEFAULT 'CNY',
  amount_scale INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6),
  stake_step_minor INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(stake_step_minor) = 'integer' AND stake_step_minor >= 0 AND stake_step_minor <= 9007199254740991),
  balance_minor INTEGER
    CHECK (balance_minor IS NULL OR (typeof(balance_minor) = 'integer' AND balance_minor >= 0 AND balance_minor <= 9007199254740991)),
  balance_updated_at TEXT NOT NULL DEFAULT '',
  execution_status TEXT NOT NULL DEFAULT 'idle',
  access_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (access_status IN ('unchecked', 'available', 'failed')),
  access_checked_at TEXT NOT NULL DEFAULT '',
  access_error_code TEXT NOT NULL DEFAULT '',
  reported_balance TEXT,
  reported_currency TEXT NOT NULL DEFAULT '',
  reported_balance_updated_at TEXT NOT NULL DEFAULT '',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  secret_updated_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_history (
  id TEXT PRIMARY KEY,
  betting_account_id TEXT,
  event_key TEXT,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  amount REAL NOT NULL DEFAULT 0,
  odds_raw TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bet_market_once_claims (
  market_once_key TEXT PRIMARY KEY,
  card_id TEXT,
  card_version INTEGER
    CHECK (card_version IS NULL OR (typeof(card_version) = 'integer' AND card_version >= 1)),
  rule_id TEXT,
  betting_mode TEXT CHECK (betting_mode IS NULL OR betting_mode IN ('prematch','live')),
  settings_version INTEGER CHECK (settings_version IS NULL OR (typeof(settings_version) = 'integer' AND settings_version >= 1)),
  signal_id TEXT NOT NULL DEFAULT '',
  batch_id TEXT,
  claim_status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (claim_status IN ('claimed', 'allocation_failed', 'batch_created')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  CHECK (
    (card_id IS NOT NULL AND card_version IS NOT NULL AND rule_id IS NULL AND betting_mode IS NOT NULL AND settings_version IS NULL)
    OR (card_id IS NULL AND card_version IS NULL AND rule_id IS NOT NULL AND betting_mode IS NULL AND settings_version IS NULL)
    OR (card_id IS NULL AND card_version IS NULL AND rule_id IS NULL AND betting_mode IS NOT NULL AND settings_version IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS real_betting_runtime (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  requested INTEGER NOT NULL DEFAULT 0 CHECK (requested IN (0,1)),
  runtime_state TEXT NOT NULL DEFAULT 'off'
    CHECK (runtime_state IN ('off', 'armed_waiting', 'running', 'blocked', 'stopping')),
  reason_code TEXT,
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS betting_rule_leagues (
  rule_id TEXT NOT NULL,
  league_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (rule_id, league_name),
  UNIQUE (league_name),
  FOREIGN KEY (rule_id) REFERENCES betting_rules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_authorizations (
  authorization_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'real' CHECK (mode = 'real'),
  currency TEXT NOT NULL DEFAULT '',
  amount_scale INTEGER NOT NULL DEFAULT 2
    CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6),
  rule_ids_json TEXT NOT NULL DEFAULT '[]',
  betting_modes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(betting_modes_json) AND json_type(betting_modes_json) = 'array'),
  eligibility_versions_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(eligibility_versions_json) AND json_type(eligibility_versions_json) = 'object'),
  card_scopes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(card_scopes_json) AND json_type(card_scopes_json) = 'array'),
  max_total_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(max_total_amount_minor) = 'integer' AND max_total_amount_minor >= 0 AND max_total_amount_minor <= 9007199254740991),
  hard_cap_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(hard_cap_amount_minor) = 'integer' AND hard_cap_amount_minor >= 0 AND hard_cap_amount_minor <= 9007199254740991),
  reserved_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(reserved_amount_minor) = 'integer' AND reserved_amount_minor >= 0 AND reserved_amount_minor <= 9007199254740991),
  accepted_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(accepted_amount_minor) = 'integer' AND accepted_amount_minor >= 0 AND accepted_amount_minor <= 9007199254740991),
  unknown_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(unknown_amount_minor) = 'integer' AND unknown_amount_minor >= 0 AND unknown_amount_minor <= 9007199254740991),
  valid_from TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'exhausted', 'expired')),
  confirmation_digest TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  CHECK (
    reserved_amount_minor + accepted_amount_minor + unknown_amount_minor
      <= max_total_amount_minor
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_authorizations_active_idx
ON execution_authorizations (status)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS execution_security_audit (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  confirmation_digest TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_security_audit_subject_idx
ON execution_security_audit (subject_type, subject_id, created_at, audit_id);

CREATE TABLE IF NOT EXISTS bet_batches (
  batch_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  card_id TEXT,
  card_version INTEGER
    CHECK (card_version IS NULL OR (typeof(card_version) = 'integer' AND card_version >= 1)),
  card_snapshot_json TEXT
    CHECK (card_snapshot_json IS NULL OR (json_valid(card_snapshot_json) AND json_type(card_snapshot_json) = 'object')),
  rule_id TEXT,
  betting_mode TEXT CHECK (betting_mode IS NULL OR betting_mode IN ('prematch','live')),
  settings_version INTEGER CHECK (settings_version IS NULL OR (typeof(settings_version) = 'integer' AND settings_version >= 1)),
  settings_snapshot_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(settings_snapshot_json) AND json_type(settings_snapshot_json) = 'object'),
  authorization_id TEXT,
  event_key TEXT NOT NULL DEFAULT '',
  locked_selection_identity TEXT NOT NULL DEFAULT '',
  rule_version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(rule_version) = 'integer' AND rule_version >= 1),
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  source_league TEXT NOT NULL DEFAULT '',
  source_odds TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  amount_scale INTEGER NOT NULL DEFAULT 2
    CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6),
  target_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(target_amount_minor) = 'integer' AND target_amount_minor >= 0 AND target_amount_minor <= 9007199254740991),
  reserved_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(reserved_amount_minor) = 'integer' AND reserved_amount_minor >= 0 AND reserved_amount_minor <= 9007199254740991),
  accepted_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(accepted_amount_minor) = 'integer' AND accepted_amount_minor >= 0 AND accepted_amount_minor <= 9007199254740991),
  unknown_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(unknown_amount_minor) = 'integer' AND unknown_amount_minor >= 0 AND unknown_amount_minor <= 9007199254740991),
  unfilled_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(unfilled_amount_minor) = 'integer' AND unfilled_amount_minor >= 0 AND unfilled_amount_minor <= 9007199254740991),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'allocating', 'waiting_capacity', 'submitting',
      'waiting_result', 'completed', 'partial', 'failed', 'cancelled'
    )),
  finish_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  UNIQUE (signal_id, rule_id),
  FOREIGN KEY (signal_id) REFERENCES monitor_signals(signal_id),
  FOREIGN KEY (rule_id) REFERENCES betting_rules(id),
  FOREIGN KEY (authorization_id) REFERENCES execution_authorizations(authorization_id),
  CHECK (
    (card_id IS NOT NULL AND card_version IS NOT NULL AND card_snapshot_json IS NOT NULL AND rule_id IS NULL AND betting_mode IS NOT NULL AND settings_version IS NULL)
    OR (card_id IS NULL AND card_version IS NULL AND card_snapshot_json IS NULL AND rule_id IS NOT NULL AND betting_mode IS NULL AND settings_version IS NULL)
    OR (card_id IS NULL AND card_version IS NULL AND card_snapshot_json IS NULL AND rule_id IS NULL AND betting_mode IS NOT NULL AND settings_version IS NOT NULL)
  ),
  CHECK (reserved_amount_minor + accepted_amount_minor + unknown_amount_minor <= target_amount_minor)
);

CREATE TABLE IF NOT EXISTS bet_child_orders (
  child_order_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(attempt) = 'integer' AND attempt >= 1),
  requested_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(requested_amount_minor) = 'integer' AND requested_amount_minor >= 0 AND requested_amount_minor <= 9007199254740991),
  preview_min_stake_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(preview_min_stake_minor) = 'integer' AND preview_min_stake_minor >= 0 AND preview_min_stake_minor <= 9007199254740991),
  preview_max_stake_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(preview_max_stake_minor) = 'integer' AND preview_max_stake_minor >= 0 AND preview_max_stake_minor <= 9007199254740991),
  preview_balance_minor INTEGER
    CHECK (preview_balance_minor IS NULL OR (typeof(preview_balance_minor) = 'integer' AND preview_balance_minor >= 0 AND preview_balance_minor <= 9007199254740991)),
  preview_stake_step_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(preview_stake_step_minor) = 'integer' AND preview_stake_step_minor >= 0 AND preview_stake_step_minor <= 9007199254740991),
  preview_odds TEXT NOT NULL DEFAULT '',
  provider_reference_ciphertext TEXT NOT NULL DEFAULT '',
  submit_attempt_id TEXT NOT NULL DEFAULT '',
  submit_prepared_at TEXT NOT NULL DEFAULT '',
  submit_dispatched_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'previewing'
    CHECK (status IN (
      'previewing', 'reserved', 'submit_prepared', 'submit_dispatched',
      'accepted', 'rejected', 'unknown', 'cancelled'
    )),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT '',
  UNIQUE (batch_id, account_id, attempt),
  FOREIGN KEY (batch_id) REFERENCES bet_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES betting_accounts(id)
);

CREATE TABLE IF NOT EXISTS bet_submit_attempts (
  submit_attempt_id TEXT PRIMARY KEY
    CHECK (length(submit_attempt_id) > 0),
  child_order_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL
    CHECK (typeof(attempt_ordinal) = 'integer' AND attempt_ordinal IN (1, 2)),
  amount_minor INTEGER NOT NULL
    CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 1 AND amount_minor <= 9007199254740991),
  fencing_token INTEGER NOT NULL
    CHECK (typeof(fencing_token) = 'integer' AND fencing_token >= 1 AND fencing_token <= 9007199254740991),
  capability_version TEXT NOT NULL
    CHECK (length(capability_version) > 0),
  capability_evidence_id TEXT NOT NULL
    CHECK (length(capability_evidence_id) > 0),
  preview_odds TEXT NOT NULL
    CHECK (length(preview_odds) > 0),
  locked_identity_json TEXT NOT NULL
    CHECK (json_valid(locked_identity_json) AND json_type(locked_identity_json) = 'object'),
  preview_snapshot_json TEXT NOT NULL
    CHECK (json_valid(preview_snapshot_json) AND json_type(preview_snapshot_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'submit_prepared'
    CHECK (status IN (
      'submit_prepared', 'submit_dispatched', 'accepted', 'rejected',
      'unknown', 'odds_changed_unsent'
    )),
  prepared_at TEXT NOT NULL
    CHECK (length(prepared_at) > 0),
  dispatched_at TEXT NOT NULL DEFAULT '',
  result_at TEXT NOT NULL DEFAULT '',
  provider_reference_ciphertext TEXT NOT NULL DEFAULT '',
  result_payload_hash TEXT NOT NULL DEFAULT ''
    CHECK (
      result_payload_hash = '' OR (
        length(result_payload_hash) = 64
        AND result_payload_hash = lower(result_payload_hash)
        AND result_payload_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (child_order_id, attempt_ordinal),
  FOREIGN KEY (child_order_id) REFERENCES bet_child_orders(child_order_id),
  FOREIGN KEY (authorization_id) REFERENCES execution_authorizations(authorization_id),
  CHECK (status <> 'submit_dispatched' OR length(dispatched_at) > 0),
  CHECK (status NOT IN ('accepted', 'rejected', 'odds_changed_unsent') OR length(dispatched_at) > 0),
  CHECK (status NOT IN ('accepted', 'rejected', 'unknown', 'odds_changed_unsent') OR length(result_at) > 0)
);

CREATE INDEX IF NOT EXISTS bet_submit_attempts_child_status_idx
ON bet_submit_attempts (child_order_id, status, attempt_ordinal);

CREATE TRIGGER IF NOT EXISTS bet_submit_attempts_immutable_update
BEFORE UPDATE OF
  submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
  amount_minor, fencing_token, capability_version, capability_evidence_id,
  preview_odds, locked_identity_json, preview_snapshot_json, prepared_at, created_at
ON bet_submit_attempts
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-attempt-immutable');
END;

CREATE TRIGGER IF NOT EXISTS bet_submit_attempts_immutable_delete
BEFORE DELETE ON bet_submit_attempts
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-attempt-immutable');
END;

CREATE TRIGGER IF NOT EXISTS bet_submit_attempts_initial_status
BEFORE INSERT ON bet_submit_attempts
WHEN NEW.status <> 'submit_prepared'
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-attempt-must-start-prepared');
END;

CREATE TRIGGER IF NOT EXISTS bet_submit_attempts_status_transition
BEFORE UPDATE OF status ON bet_submit_attempts
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'submit_prepared' AND NEW.status IN ('submit_dispatched', 'unknown'))
  OR (OLD.status = 'submit_dispatched' AND NEW.status IN ('accepted', 'rejected', 'unknown', 'odds_changed_unsent'))
  OR (OLD.status = 'unknown' AND NEW.status IN ('accepted', 'rejected'))
)
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-attempt-invalid-transition');
END;

CREATE TABLE IF NOT EXISTS bet_reconciliation_state (
  submit_attempt_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'polling', 'waiting', 'manual_review', 'resolved', 'dead_letter')),
  poll_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(poll_count) = 'integer' AND poll_count >= 0 AND poll_count <= 9007199254740991),
  next_poll_at TEXT NOT NULL DEFAULT '',
  deadline_at TEXT NOT NULL
    CHECK (length(deadline_at) > 0),
  last_source TEXT NOT NULL DEFAULT ''
    CHECK (last_source IN ('', 'get_dangerous', 'today_wagers', 'manual')),
  last_payload_hash TEXT NOT NULL DEFAULT ''
    CHECK (
      last_payload_hash = '' OR (
        length(last_payload_hash) = 64
        AND last_payload_hash = lower(last_payload_hash)
        AND last_payload_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submit_attempt_id) REFERENCES bet_submit_attempts(submit_attempt_id)
);

CREATE INDEX IF NOT EXISTS bet_reconciliation_state_due_idx
ON bet_reconciliation_state (status, next_poll_at, deadline_at, submit_attempt_id);

CREATE TABLE IF NOT EXISTS bet_reconciliation_evidence (
  evidence_id TEXT PRIMARY KEY
    CHECK (length(evidence_id) > 0),
  submit_attempt_id TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('get_dangerous', 'today_wagers', 'manual')),
  decision TEXT NOT NULL
    CHECK (decision IN ('pending', 'accepted', 'rejected', 'unknown', 'no_match')),
  payload_hash TEXT NOT NULL
    CHECK (
      length(payload_hash) = 64
      AND payload_hash = lower(payload_hash)
      AND payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  operator_id TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL
    CHECK (length(observed_at) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (submit_attempt_id, source, decision, payload_hash),
  FOREIGN KEY (submit_attempt_id) REFERENCES bet_submit_attempts(submit_attempt_id),
  CHECK (source <> 'manual' OR length(operator_id) > 0)
);

CREATE INDEX IF NOT EXISTS bet_reconciliation_evidence_attempt_idx
ON bet_reconciliation_evidence (submit_attempt_id, observed_at, evidence_id);

CREATE TRIGGER IF NOT EXISTS bet_reconciliation_evidence_immutable_update
BEFORE UPDATE ON bet_reconciliation_evidence
BEGIN
  SELECT RAISE(ABORT, 'bet-reconciliation-evidence-immutable');
END;

CREATE TRIGGER IF NOT EXISTS bet_reconciliation_evidence_immutable_delete
BEFORE DELETE ON bet_reconciliation_evidence
BEGIN
  SELECT RAISE(ABORT, 'bet-reconciliation-evidence-immutable');
END;

CREATE TABLE IF NOT EXISTS bet_notification_outbox (
  notification_id TEXT PRIMARY KEY
    CHECK (length(notification_id) > 0),
  batch_id TEXT NOT NULL,
  child_order_id TEXT NOT NULL,
  final_status TEXT NOT NULL
    CHECK (final_status IN ('accepted', 'rejected', 'unknown', 'cancelled', 'partial', 'failed', 'circuit_open')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0 AND attempt_count <= 9007199254740991),
  next_attempt_at TEXT NOT NULL DEFAULT '',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_fencing_token INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(lease_fencing_token) = 'integer' AND lease_fencing_token >= 0 AND lease_fencing_token <= 9007199254740991),
  lease_expires_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT '',
  UNIQUE (batch_id, child_order_id, final_status),
  FOREIGN KEY (batch_id) REFERENCES bet_batches(batch_id),
  FOREIGN KEY (child_order_id) REFERENCES bet_child_orders(child_order_id)
);

CREATE INDEX IF NOT EXISTS bet_notification_outbox_due_idx
ON bet_notification_outbox (status, next_attempt_at, lease_expires_at, notification_id);

CREATE TRIGGER IF NOT EXISTS bet_notification_outbox_child_batch_insert
BEFORE INSERT ON bet_notification_outbox
WHEN NOT EXISTS (
  SELECT 1
  FROM bet_child_orders
  WHERE child_order_id = NEW.child_order_id
    AND batch_id = NEW.batch_id
)
BEGIN
  SELECT RAISE(ABORT, 'bet-notification-child-batch-mismatch');
END;

CREATE TRIGGER IF NOT EXISTS bet_notification_outbox_immutable_identity
BEFORE UPDATE OF notification_id, batch_id, child_order_id, final_status, created_at
ON bet_notification_outbox
BEGIN
  SELECT RAISE(ABORT, 'bet-notification-identity-immutable');
END;

CREATE TRIGGER IF NOT EXISTS bet_notification_outbox_status_transition
BEFORE UPDATE OF status ON bet_notification_outbox
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'pending' AND NEW.status IN ('delivering', 'dead_letter'))
  OR (OLD.status = 'delivering' AND NEW.status IN ('pending', 'delivered', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'bet-notification-invalid-transition');
END;

CREATE TRIGGER IF NOT EXISTS bet_notification_outbox_delivery_counters
BEFORE UPDATE ON bet_notification_outbox
WHEN NEW.attempt_count < OLD.attempt_count
  OR NEW.lease_fencing_token < OLD.lease_fencing_token
BEGIN
  SELECT RAISE(ABORT, 'bet-notification-counter-regression');
END;

CREATE TABLE IF NOT EXISTS execution_authorization_child_budgets (
  child_order_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL
    CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 1 AND amount_minor <= 9007199254740991),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'accepted', 'unknown', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (child_order_id) REFERENCES bet_child_orders(child_order_id) ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES execution_authorizations(authorization_id),
  FOREIGN KEY (batch_id) REFERENCES bet_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES betting_accounts(id)
);

CREATE INDEX IF NOT EXISTS execution_authorization_child_budgets_auth_idx
ON execution_authorization_child_budgets (authorization_id, status, batch_id, child_order_id);

CREATE TABLE IF NOT EXISTS betting_account_locks (
  account_id TEXT PRIMARY KEY,
  child_order_id TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'submitting', 'unknown')),
  fencing_token INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(fencing_token) = 'integer' AND fencing_token >= 0),
  acquired_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (account_id) REFERENCES betting_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (child_order_id) REFERENCES bet_child_orders(child_order_id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES bet_batches(batch_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(pid) = 'integer' AND pid >= 0),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(fencing_token) = 'integer' AND fencing_token >= 1)
);

CREATE TABLE IF NOT EXISTS monitor_scope_state (
  scope_key TEXT PRIMARY KEY,
  last_batch_id TEXT NOT NULL,
  last_captured_at TEXT NOT NULL,
  last_complete_at TEXT NOT NULL,
  event_keys_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS monitor_event_state (
  event_key TEXT PRIMARY KEY,
  match_group_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  missing_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  provider_ids_json TEXT NOT NULL DEFAULT '{}',
  event_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS monitor_selection_state (
  selection_identity TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_signals (
  signal_id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_cooldowns (
  signal_key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_deliveries (
  signal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, channel)
);

CREATE INDEX IF NOT EXISTS monitor_deliveries_due_idx
ON monitor_deliveries (status, next_attempt_at, updated_at, signal_id, channel);

CREATE TABLE IF NOT EXISTS monitor_audit_outbox (
  fact_id TEXT PRIMARY KEY,
  fact_kind TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS monitor_audit_outbox_pending_idx
ON monitor_audit_outbox (status, created_at, fact_id);

CREATE TABLE IF NOT EXISTS monitor_candidates (
  candidate_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  export_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  exported_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS monitor_candidates_export_idx
ON monitor_candidates (export_status, created_at, candidate_id);

CREATE UNIQUE INDEX IF NOT EXISTS monitor_candidates_signal_idx
ON monitor_candidates (signal_id);
`

const MIGRATIONS = [
  ['monitor_accounts', 'enabled', 'ALTER TABLE monitor_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0'],
  ['monitor_accounts', 'login_status', "ALTER TABLE monitor_accounts ADD COLUMN login_status TEXT NOT NULL DEFAULT '未启动'"],
  ['monitor_accounts', 'current_monitor_status', "ALTER TABLE monitor_accounts ADD COLUMN current_monitor_status TEXT NOT NULL DEFAULT '未启动'"],
  ['monitor_accounts', 'last_login_at', "ALTER TABLE monitor_accounts ADD COLUMN last_login_at TEXT NOT NULL DEFAULT ''"],
  ['monitor_accounts', 'last_online_check_at', "ALTER TABLE monitor_accounts ADD COLUMN last_online_check_at TEXT NOT NULL DEFAULT ''"],
  ['monitor_accounts', 'last_xml_response_at', "ALTER TABLE monitor_accounts ADD COLUMN last_xml_response_at TEXT NOT NULL DEFAULT ''"],
  ['monitor_accounts', 'last_odds_parsed_at', "ALTER TABLE monitor_accounts ADD COLUMN last_odds_parsed_at TEXT NOT NULL DEFAULT ''"],
  ['monitor_accounts', 'consecutive_failures', 'ALTER TABLE monitor_accounts ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0'],
  ['monitor_accounts', 'odds_scan_interval_seconds', 'ALTER TABLE monitor_accounts ADD COLUMN odds_scan_interval_seconds INTEGER NOT NULL DEFAULT 10'],
  ['monitor_accounts', 'auto_relogin_count', 'ALTER TABLE monitor_accounts ADD COLUMN auto_relogin_count INTEGER NOT NULL DEFAULT 0'],
  ['monitor_accounts', 'max_auto_relogin_count', 'ALTER TABLE monitor_accounts ADD COLUMN max_auto_relogin_count INTEGER NOT NULL DEFAULT 3'],
  ['monitor_accounts', 'last_login_result_json', "ALTER TABLE monitor_accounts ADD COLUMN last_login_result_json TEXT NOT NULL DEFAULT '{}'"],
  ['monitor_accounts', 'last_login_result_at', "ALTER TABLE monitor_accounts ADD COLUMN last_login_result_at TEXT NOT NULL DEFAULT ''"],
  ['monitor_accounts', 'last_login_diagnostics_path', "ALTER TABLE monitor_accounts ADD COLUMN last_login_diagnostics_path TEXT NOT NULL DEFAULT ''"],
  ['betting_rules', 'per_account_bet_amount', 'ALTER TABLE betting_rules ADD COLUMN per_account_bet_amount REAL NOT NULL DEFAULT 0'],
  ['betting_rules', 'per_account_daily_limit', 'ALTER TABLE betting_rules ADD COLUMN per_account_daily_limit REAL NOT NULL DEFAULT 0'],
  ['betting_rules', 'priority', 'ALTER TABLE betting_rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 1'],
  ['betting_rules', 'monitor_enabled', 'ALTER TABLE betting_rules ADD COLUMN monitor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitor_enabled IN (0,1))'],
  ['betting_rules', 'real_betting_enabled', 'ALTER TABLE betting_rules ADD COLUMN real_betting_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_betting_enabled IN (0,1))'],
  ['betting_rules', 'archived', 'ALTER TABLE betting_rules ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))'],
  ['betting_rules', 'mode', "ALTER TABLE betting_rules ADD COLUMN mode TEXT NOT NULL DEFAULT 'prematch' CHECK (mode IN ('prematch','live'))"],
  ['betting_rules', 'period', "ALTER TABLE betting_rules ADD COLUMN period TEXT NOT NULL DEFAULT 'full' CHECK (period IN ('full','first_half','second_half'))"],
  ['betting_rules', 'market_type', "ALTER TABLE betting_rules ADD COLUMN market_type TEXT NOT NULL DEFAULT 'asian_handicap' CHECK (market_type IN ('asian_handicap','total'))"],
  ['betting_rules', 'monitored_side', "ALTER TABLE betting_rules ADD COLUMN monitored_side TEXT NOT NULL DEFAULT 'home' CHECK (monitored_side IN ('home','away','over','under'))"],
  ['betting_rules', 'min_water_rise', "ALTER TABLE betting_rules ADD COLUMN min_water_rise TEXT NOT NULL DEFAULT '0.01'"],
  ['betting_rules', 'target_odds_min', "ALTER TABLE betting_rules ADD COLUMN target_odds_min TEXT NOT NULL DEFAULT '0'"],
  ['betting_rules', 'target_odds_max', "ALTER TABLE betting_rules ADD COLUMN target_odds_max TEXT NOT NULL DEFAULT '2'"],
  ['betting_rules', 'start_minutes_before_kickoff', 'ALTER TABLE betting_rules ADD COLUMN start_minutes_before_kickoff INTEGER'],
  ['betting_rules', 'stop_minutes_before_kickoff', 'ALTER TABLE betting_rules ADD COLUMN stop_minutes_before_kickoff INTEGER'],
  ['betting_rules', 'live_minute_from', 'ALTER TABLE betting_rules ADD COLUMN live_minute_from INTEGER'],
  ['betting_rules', 'live_minute_to', 'ALTER TABLE betting_rules ADD COLUMN live_minute_to INTEGER'],
  ['betting_rules', 'migration_review_required', 'ALTER TABLE betting_rules ADD COLUMN migration_review_required INTEGER NOT NULL DEFAULT 0 CHECK (migration_review_required IN (0,1))'],
  ['betting_rules', 'bet_direction_mode', "ALTER TABLE betting_rules ADD COLUMN bet_direction_mode TEXT NOT NULL DEFAULT 'auto'"],
  ['betting_rules', 'execution_mode', "ALTER TABLE betting_rules ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'preview_only' CHECK (execution_mode IN ('preview_only', 'real_eligible'))"],
  ['betting_rules', 'currency', "ALTER TABLE betting_rules ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'"],
  ['betting_rules', 'amount_scale', "ALTER TABLE betting_rules ADD COLUMN amount_scale INTEGER NOT NULL DEFAULT 0 CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6)"],
  ['betting_rules', 'target_amount_minor', "ALTER TABLE betting_rules ADD COLUMN target_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(target_amount_minor) = 'integer' AND target_amount_minor >= 0 AND target_amount_minor <= 9007199254740991)"],
  ['betting_rules', 'league_names_json', "ALTER TABLE betting_rules ADD COLUMN league_names_json TEXT NOT NULL DEFAULT '[]'"],
  ['betting_rules', 'changed_odds_min', 'ALTER TABLE betting_rules ADD COLUMN changed_odds_min REAL'],
  ['betting_rules', 'changed_odds_max', 'ALTER TABLE betting_rules ADD COLUMN changed_odds_max REAL'],
  ['betting_rules', 'version', "ALTER TABLE betting_rules ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1)"],
  ['betting_accounts', 'website_url', "ALTER TABLE betting_accounts ADD COLUMN website_url TEXT NOT NULL DEFAULT ''"],
  ['betting_accounts', 'bet_order', 'ALTER TABLE betting_accounts ADD COLUMN bet_order INTEGER NOT NULL DEFAULT 0'],
  ['betting_accounts', 'archived', 'ALTER TABLE betting_accounts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))'],
  ['betting_accounts', 'allocation_status', "ALTER TABLE betting_accounts ADD COLUMN allocation_status TEXT NOT NULL DEFAULT 'paused' CHECK (allocation_status IN ('enabled', 'pause_pending', 'paused', 'checking'))"],
  ['betting_accounts', 'per_bet_limit_minor', "ALTER TABLE betting_accounts ADD COLUMN per_bet_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(per_bet_limit_minor) = 'integer' AND per_bet_limit_minor >= 0 AND per_bet_limit_minor <= 9007199254740991)"],
  ['betting_accounts', 'currency', "ALTER TABLE betting_accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'"],
  ['betting_accounts', 'amount_scale', "ALTER TABLE betting_accounts ADD COLUMN amount_scale INTEGER NOT NULL DEFAULT 0 CHECK (typeof(amount_scale) = 'integer' AND amount_scale >= 0 AND amount_scale <= 6)"],
  ['betting_accounts', 'stake_step_minor', "ALTER TABLE betting_accounts ADD COLUMN stake_step_minor INTEGER NOT NULL DEFAULT 1 CHECK (typeof(stake_step_minor) = 'integer' AND stake_step_minor >= 0 AND stake_step_minor <= 9007199254740991)"],
  ['betting_accounts', 'balance_minor', "ALTER TABLE betting_accounts ADD COLUMN balance_minor INTEGER CHECK (balance_minor IS NULL OR (typeof(balance_minor) = 'integer' AND balance_minor >= 0 AND balance_minor <= 9007199254740991))"],
  ['betting_accounts', 'balance_updated_at', "ALTER TABLE betting_accounts ADD COLUMN balance_updated_at TEXT NOT NULL DEFAULT ''"],
  ['betting_accounts', 'execution_status', "ALTER TABLE betting_accounts ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'idle'"],
  ['betting_accounts', 'access_status', "ALTER TABLE betting_accounts ADD COLUMN access_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (access_status IN ('unchecked', 'available', 'failed'))"],
  ['betting_accounts', 'access_checked_at', "ALTER TABLE betting_accounts ADD COLUMN access_checked_at TEXT NOT NULL DEFAULT ''"],
  ['betting_accounts', 'access_error_code', "ALTER TABLE betting_accounts ADD COLUMN access_error_code TEXT NOT NULL DEFAULT ''"],
  ['betting_accounts', 'reported_balance', "ALTER TABLE betting_accounts ADD COLUMN reported_balance TEXT"],
  ['betting_accounts', 'reported_currency', "ALTER TABLE betting_accounts ADD COLUMN reported_currency TEXT NOT NULL DEFAULT ''"],
  ['betting_accounts', 'reported_balance_updated_at', "ALTER TABLE betting_accounts ADD COLUMN reported_balance_updated_at TEXT NOT NULL DEFAULT ''"],
  ['execution_authorizations', 'hard_cap_amount_minor', "ALTER TABLE execution_authorizations ADD COLUMN hard_cap_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(hard_cap_amount_minor) = 'integer' AND hard_cap_amount_minor >= 0 AND hard_cap_amount_minor <= 9007199254740991)"],
  ['execution_authorizations', 'betting_modes_json', "ALTER TABLE execution_authorizations ADD COLUMN betting_modes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(betting_modes_json) AND json_type(betting_modes_json) = 'array')"],
  ['execution_authorizations', 'eligibility_versions_json', "ALTER TABLE execution_authorizations ADD COLUMN eligibility_versions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(eligibility_versions_json) AND json_type(eligibility_versions_json) = 'object')"],
  ['execution_authorizations', 'card_scopes_json', "ALTER TABLE execution_authorizations ADD COLUMN card_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(card_scopes_json) AND json_type(card_scopes_json) = 'array')"],
  ['auto_betting_signal_inbox', 'card_id', 'ALTER TABLE auto_betting_signal_inbox ADD COLUMN card_id TEXT'],
  ['auto_betting_signal_inbox', 'card_version', "ALTER TABLE auto_betting_signal_inbox ADD COLUMN card_version INTEGER CHECK (card_version IS NULL OR (typeof(card_version) = 'integer' AND card_version >= 1))"],
  ['auto_betting_signal_inbox', 'card_snapshot_json', "ALTER TABLE auto_betting_signal_inbox ADD COLUMN card_snapshot_json TEXT CHECK (card_snapshot_json IS NULL OR (json_valid(card_snapshot_json) AND json_type(card_snapshot_json) = 'object'))"],
  ['bet_batches', 'card_id', 'ALTER TABLE bet_batches ADD COLUMN card_id TEXT'],
  ['bet_batches', 'card_version', "ALTER TABLE bet_batches ADD COLUMN card_version INTEGER CHECK (card_version IS NULL OR (typeof(card_version) = 'integer' AND card_version >= 1))"],
  ['bet_batches', 'card_snapshot_json', "ALTER TABLE bet_batches ADD COLUMN card_snapshot_json TEXT CHECK (card_snapshot_json IS NULL OR (json_valid(card_snapshot_json) AND json_type(card_snapshot_json) = 'object'))"],
  ['bet_batches', 'betting_mode', "ALTER TABLE bet_batches ADD COLUMN betting_mode TEXT CHECK (betting_mode IS NULL OR betting_mode IN ('prematch','live'))"],
  ['bet_batches', 'settings_version', "ALTER TABLE bet_batches ADD COLUMN settings_version INTEGER CHECK (settings_version IS NULL OR (typeof(settings_version) = 'integer' AND settings_version >= 1))"],
  ['bet_batches', 'settings_snapshot_json', "ALTER TABLE bet_batches ADD COLUMN settings_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_snapshot_json) AND json_type(settings_snapshot_json) = 'object')"],
  ['bet_market_once_claims', 'betting_mode', "ALTER TABLE bet_market_once_claims ADD COLUMN betting_mode TEXT CHECK (betting_mode IS NULL OR betting_mode IN ('prematch','live'))"],
  ['bet_market_once_claims', 'settings_version', "ALTER TABLE bet_market_once_claims ADD COLUMN settings_version INTEGER CHECK (settings_version IS NULL OR (typeof(settings_version) = 'integer' AND settings_version >= 1))"],
  ['bet_market_once_claims', 'card_id', 'ALTER TABLE bet_market_once_claims ADD COLUMN card_id TEXT'],
  ['bet_market_once_claims', 'card_version', "ALTER TABLE bet_market_once_claims ADD COLUMN card_version INTEGER CHECK (card_version IS NULL OR (typeof(card_version) = 'integer' AND card_version >= 1))"],
]

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function applyMigrations(db) {
  const cache = new Map()
  const added = new Set()
  for (const [table, column, sql] of MIGRATIONS) {
    if (!cache.has(table)) cache.set(table, tableColumns(db, table))
    const columns = cache.get(table)
    if (columns.has(column)) continue
    db.exec(sql)
    columns.add(column)
    added.add(`${table}.${column}`)
  }
  return added
}

function inboxCreateTableSql(name) {
  const marker = 'CREATE TABLE IF NOT EXISTS auto_betting_signal_inbox ('
  const start = SCHEMA.indexOf(marker)
  const end = SCHEMA.indexOf('\n\nCREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_settings_immutable', start)
  if (start < 0 || end < 0) throw new Error('canonical-schema-missing:auto_betting_signal_inbox')
  return SCHEMA.slice(start, end).trim().replace(
    'CREATE TABLE IF NOT EXISTS auto_betting_signal_inbox',
    `CREATE TABLE ${name}`,
  )
}

function createInboxSchemaObjects(db) {
  db.exec(`
    DROP INDEX IF EXISTS auto_betting_signal_inbox_pending_idx;
    CREATE INDEX auto_betting_signal_inbox_pending_idx
    ON auto_betting_signal_inbox (status, next_attempt_at, created_at, signal_id, card_id);
    CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_settings_immutable
    BEFORE UPDATE OF mode, settings_version, settings_snapshot_json ON auto_betting_signal_inbox
    WHEN NEW.mode IS NOT OLD.mode OR NEW.settings_version IS NOT OLD.settings_version
      OR NEW.settings_snapshot_json IS NOT OLD.settings_snapshot_json
    BEGIN SELECT RAISE(ABORT, 'auto-betting-inbox-settings-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_card_immutable
    BEFORE UPDATE OF card_id, card_version, card_snapshot_json ON auto_betting_signal_inbox
    WHEN NEW.card_id IS NOT OLD.card_id OR NEW.card_version IS NOT OLD.card_version
      OR NEW.card_snapshot_json IS NOT OLD.card_snapshot_json
    BEGIN SELECT RAISE(ABORT, 'auto-betting-inbox-card-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_state_safe_insert
    BEFORE INSERT ON auto_betting_signal_inbox
    WHEN NOT (
      ((NEW.status='processing' AND trim(NEW.lease_owner)<>'' AND trim(NEW.lease_expires_at)<>'')
        OR (NEW.status<>'processing' AND NEW.lease_owner='' AND NEW.lease_expires_at=''))
      AND ((NEW.status='batch_created' AND NEW.batch_id IS NOT NULL AND trim(NEW.batch_id)<>'')
        OR (NEW.status<>'batch_created' AND NEW.batch_id IS NULL))
    ) BEGIN SELECT RAISE(ABORT, 'auto-betting-inbox-state-lease-batch-constraint'); END;
    CREATE TRIGGER IF NOT EXISTS auto_betting_signal_inbox_state_safe_update
    BEFORE UPDATE ON auto_betting_signal_inbox
    WHEN NOT (
      ((NEW.status='processing' AND trim(NEW.lease_owner)<>'' AND trim(NEW.lease_expires_at)<>'')
        OR (NEW.status<>'processing' AND NEW.lease_owner='' AND NEW.lease_expires_at=''))
      AND ((NEW.status='batch_created' AND NEW.batch_id IS NOT NULL AND trim(NEW.batch_id)<>'')
        OR (NEW.status<>'batch_created' AND NEW.batch_id IS NULL))
    ) BEGIN SELECT RAISE(ABORT, 'auto-betting-inbox-state-lease-batch-constraint'); END;
    ${INBOX_DELETE_TRIGGER};
  `)
}

function migrateInboxCompositeIdentity(db) {
  const info = db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all()
  const primaryKey = info.filter((row) => row.pk).sort((a, b) => a.pk - b.pk).map((row) => row.name)
  const requiredCardColumns = ['card_id', 'card_version', 'card_snapshot_json']
  const canonical = primaryKey.length === 2 && primaryKey[0] === 'signal_id'
    && primaryKey[1] === 'card_id'
    && requiredCardColumns.every((name) => info.find((row) => row.name === name)?.notnull === 1)
  if (!canonical) {
    const replacement = 'auto_betting_signal_inbox__card_identity'
    const legacyRows = db.prepare(`
      SELECT rowid AS legacy_rowid, * FROM auto_betting_signal_inbox ORDER BY rowid
    `).all()
    const occupiedBySignal = new Map()
    for (const row of legacyRows) {
      const existing = typeof row.card_id === 'string' ? row.card_id.trim() : ''
      if (!existing) continue
      const occupied = occupiedBySignal.get(row.signal_id) || new Set()
      occupied.add(existing)
      occupiedBySignal.set(row.signal_id, occupied)
    }
    db.exec(`
      DROP TRIGGER IF EXISTS auto_betting_signal_inbox_append_only_delete;
      DROP TRIGGER IF EXISTS auto_betting_signal_inbox_settings_immutable;
      DROP TRIGGER IF EXISTS auto_betting_signal_inbox_card_immutable;
      DROP TRIGGER IF EXISTS auto_betting_signal_inbox_state_safe_insert;
      DROP TRIGGER IF EXISTS auto_betting_signal_inbox_state_safe_update;
      DROP INDEX IF EXISTS auto_betting_signal_inbox_pending_idx;
      DROP TABLE IF EXISTS ${replacement};
      ${inboxCreateTableSql(replacement)};
    `)
    const insert = db.prepare(`INSERT INTO ${replacement} (
        signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,
        status,skip_reason,attempts,next_attempt_at,lease_owner,lease_expires_at,batch_id,created_at,updated_at
      ) VALUES (${Array.from({ length: 16 }, () => '?').join(',')})`)
    for (const row of legacyRows) {
      const missingCardId = typeof row.card_id !== 'string' || row.card_id.trim() === ''
      const incompleteCard = missingCardId || row.card_version === null || row.card_snapshot_json === null
      let cardId = missingCardId ? '' : row.card_id
      const occupied = occupiedBySignal.get(row.signal_id) || new Set()
      if (missingCardId) {
        const base = `legacy-fixed:${row.mode}:${row.legacy_rowid}`
        cardId = base
        let suffix = 0
        while (occupied.has(cardId)) {
          suffix += 1
          cardId = `${base}:${suffix}`
        }
        occupied.add(cardId)
        occupiedBySignal.set(row.signal_id, occupied)
      }
      const terminalize = incompleteCard && ['pending', 'retry', 'processing'].includes(row.status)
      insert.run(
        row.signal_id,
        cardId,
        row.card_version ?? row.settings_version,
        row.card_snapshot_json ?? row.settings_snapshot_json,
        row.mode,
        row.settings_version,
        row.settings_snapshot_json,
        terminalize ? 'skipped' : row.status,
        terminalize ? 'rule-deleted' : row.skip_reason,
        row.attempts,
        terminalize ? '' : row.next_attempt_at,
        terminalize ? '' : row.lease_owner,
        terminalize ? '' : row.lease_expires_at,
        row.batch_id,
        row.created_at,
        row.updated_at,
      )
    }
    db.exec(`
      DROP TABLE auto_betting_signal_inbox;
      ALTER TABLE ${replacement} RENAME TO auto_betting_signal_inbox;
    `)
  }
  createInboxSchemaObjects(db)
}

const AUTHORIZATION_GUARD_COLUMNS = [
  'mode', 'amount_scale', 'max_total_amount_minor', 'reserved_amount_minor',
  'accepted_amount_minor', 'unknown_amount_minor', 'status',
]

function authorizationGuardExpression(prefix = '', { includeHardCap = true } = {}) {
  const field = (name) => `${prefix}${name}`
  const safeInteger = (name) => `typeof(${field(name)}) = 'integer' AND ${field(name)} >= 0 AND ${field(name)} <= 9007199254740991`
  return [
    `${field('mode')} = 'real'`,
    `typeof(${field('amount_scale')}) = 'integer' AND ${field('amount_scale')} >= 0 AND ${field('amount_scale')} <= 6`,
    safeInteger('max_total_amount_minor'),
    ...(includeHardCap ? [safeInteger('hard_cap_amount_minor')] : []),
    safeInteger('reserved_amount_minor'),
    safeInteger('accepted_amount_minor'),
    safeInteger('unknown_amount_minor'),
    `${field('accepted_amount_minor')} <= ${field('max_total_amount_minor')}`,
    `${field('unknown_amount_minor')} <= ${field('max_total_amount_minor')} - ${field('accepted_amount_minor')}`,
    `${field('reserved_amount_minor')} <= ${field('max_total_amount_minor')} - ${field('accepted_amount_minor')} - ${field('unknown_amount_minor')}`,
    `${field('status')} IN ('active', 'revoked', 'exhausted', 'expired')`,
  ].join(' AND ')
}

function assertLegacyExecutionAuthorizationsSafe(db) {
  const columns = tableColumns(db, 'execution_authorizations')
  const missing = AUTHORIZATION_GUARD_COLUMNS.filter((column) => !columns.has(column))
  if (missing.length) throw new Error('execution-authorization-legacy-schema-invalid')
  const includeHardCap = columns.has('hard_cap_amount_minor')
  const invalid = db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM execution_authorizations
      WHERE COALESCE((${authorizationGuardExpression('', { includeHardCap })}), 0) = 0
    ) AS invalid
  `).get().invalid
  if (invalid) throw new Error('execution-authorization-legacy-invalid')
}

function applyExecutionAuthorizationGuards(db) {
  const guard = authorizationGuardExpression('NEW.')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS execution_authorizations_safe_insert
    BEFORE INSERT ON execution_authorizations
    WHEN COALESCE((${guard}), 0) = 0
    BEGIN
      SELECT RAISE(ABORT, 'execution-authorization-constraint');
    END;

    CREATE TRIGGER IF NOT EXISTS execution_authorizations_safe_update
    BEFORE UPDATE ON execution_authorizations
    WHEN COALESCE((${guard}), 0) = 0
    BEGIN
      SELECT RAISE(ABORT, 'execution-authorization-constraint');
    END;
  `)
}

function authorizationScopeGuard(prefix = '') {
  const modes = `${prefix}betting_modes_json`
  const versions = `${prefix}eligibility_versions_json`
  const cards = `${prefix}card_scopes_json`
  return `
    json_valid(${modes}) AND json_type(${modes}) = 'array'
    AND json_valid(${versions}) AND json_type(${versions}) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${modes}) AS mode
      WHERE mode.type <> 'text' OR mode.value NOT IN ('prematch','live')
    )
    AND (SELECT COUNT(*) FROM json_each(${modes}))
      = (SELECT COUNT(DISTINCT value) FROM json_each(${modes}))
    AND (SELECT COUNT(*) FROM json_each(${versions}))
      = (SELECT COUNT(DISTINCT key) FROM json_each(${versions}))
    AND json_valid(${cards}) AND json_type(${cards}) = 'array'
    AND (
      ((SELECT COUNT(*) FROM json_each(${cards})) = 0 AND NOT EXISTS (
      SELECT 1
      FROM json_each(${modes}) AS mode
      LEFT JOIN json_each(${versions}) AS version ON version.key = mode.value
      WHERE version.key IS NULL OR version.type <> 'integer'
        OR version.value < 1 OR version.value > 9007199254740991
      ) AND NOT EXISTS (
      SELECT 1
      FROM json_each(${versions}) AS version
      LEFT JOIN json_each(${modes}) AS mode ON mode.value = version.key
      WHERE mode.value IS NULL OR version.key NOT IN ('prematch','live')
        OR version.type <> 'integer' OR version.value < 1
        OR version.value > 9007199254740991
      ))
      OR
      ((SELECT COUNT(*) FROM json_each(${cards})) > 0
        AND (SELECT COUNT(*) FROM json_each(${versions})) = 0
        AND (SELECT COUNT(*) FROM json_each(${cards})) =
          (SELECT COUNT(DISTINCT json_extract(value,'$.cardId')) FROM json_each(${cards}))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${cards}) AS scope
          WHERE scope.type <> 'object'
            OR json_type(scope.value,'$.cardId') <> 'text' OR trim(json_extract(scope.value,'$.cardId')) = ''
            OR json_type(scope.value,'$.eligibilityVersion') <> 'integer'
            OR json_extract(scope.value,'$.eligibilityVersion') < 1
            OR (SELECT COUNT(*) FROM json_each(scope.value)) <> 2
        ))
    )
  `
}

function applyAuthorizationScopeGuards(db) {
  const invalid = db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM execution_authorizations
      WHERE NOT (${authorizationScopeGuard()})
    ) AS invalid
  `).get().invalid
  if (invalid) throw new Error('execution-authorization-scope-legacy-invalid')
  const guard = authorizationScopeGuard('NEW.')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS execution_authorizations_scope_safe_insert
    BEFORE INSERT ON execution_authorizations
    WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'execution-authorization-scope-constraint');
    END;

    CREATE TRIGGER IF NOT EXISTS execution_authorizations_scope_safe_update
    BEFORE UPDATE OF betting_modes_json, eligibility_versions_json, card_scopes_json ON execution_authorizations
    WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'execution-authorization-scope-constraint');
    END;
  `)
}

function applySeparatedExecutionScopeGuards(db) {
  const guard = `
    (
      (NEW.card_id IS NOT NULL AND NEW.card_version IS NOT NULL AND NEW.rule_id IS NULL AND NEW.betting_mode IS NOT NULL AND NEW.settings_version IS NULL)
      OR (NEW.card_id IS NULL AND NEW.card_version IS NULL AND NEW.rule_id IS NOT NULL AND NEW.betting_mode IS NULL AND NEW.settings_version IS NULL)
      OR (NEW.card_id IS NULL AND NEW.card_version IS NULL AND NEW.rule_id IS NULL AND NEW.betting_mode IS NOT NULL AND NEW.settings_version IS NOT NULL)
    )
  `
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS bet_batches_signal_mode_settings_idx
    ON bet_batches (signal_id, betting_mode, settings_version)
    WHERE betting_mode IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS bet_batches_signal_card_version_idx
    ON bet_batches (signal_id, card_id, card_version)
    WHERE card_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS bet_batches_settings_scope_safe_insert
    BEFORE INSERT ON bet_batches WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'bet-batch-settings-scope-constraint');
    END;

    CREATE TRIGGER IF NOT EXISTS bet_batches_settings_scope_safe_update
    BEFORE UPDATE OF card_id, card_version, card_snapshot_json, rule_id, betting_mode, settings_version ON bet_batches
    WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'bet-batch-settings-scope-constraint');
    END;

    CREATE TRIGGER IF NOT EXISTS bet_market_once_claims_settings_scope_safe_insert
    BEFORE INSERT ON bet_market_once_claims WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'bet-market-once-settings-scope-constraint');
    END;

    CREATE TRIGGER IF NOT EXISTS bet_market_once_claims_settings_scope_safe_update
    BEFORE UPDATE OF rule_id, betting_mode, settings_version ON bet_market_once_claims
    WHEN NOT (${guard})
    BEGIN
      SELECT RAISE(ABORT, 'bet-market-once-settings-scope-constraint');
    END;
  `)
}

function applyDataMigrations(db, addedColumns) {
  if (addedColumns.has('betting_rules.league_names_json')) {
    const rules = db.prepare('SELECT id FROM betting_rules').all()
    const leaguesForRule = db.prepare('SELECT league_name FROM betting_rule_leagues WHERE rule_id = ? ORDER BY league_name')
    const saveLeagues = db.prepare('UPDATE betting_rules SET league_names_json = ? WHERE id = ?')
    for (const rule of rules) {
      const leagueNames = leaguesForRule.all(rule.id).map((row) => row.league_name)
      saveLeagues.run(JSON.stringify(leagueNames), rule.id)
    }
  }
  if (addedColumns.has('betting_rules.execution_mode')) {
    db.prepare(`
      UPDATE betting_rules
      SET enabled = 0, execution_mode = 'preview_only'
    `).run()
  }
  if (addedColumns.has('betting_rules.migration_review_required')) {
    db.prepare(`
      UPDATE betting_rules
      SET
        currency = 'CNY',
        amount_scale = 0,
        target_amount_minor = CASE
          WHEN typeof(per_account_bet_amount) IN ('integer', 'real')
            AND per_account_bet_amount >= 0
            AND per_account_bet_amount = CAST(per_account_bet_amount AS INTEGER)
            AND per_account_bet_amount <= 9007199254740991
          THEN CAST(per_account_bet_amount AS INTEGER)
          ELSE 0
        END,
        enabled = 0,
        monitor_enabled = 0,
        real_betting_enabled = 0,
        migration_review_required = 1
    `).run()
  }
  if (addedColumns.has('betting_accounts.allocation_status')) {
    const columns = tableColumns(db, 'betting_accounts')
    const legacyAmount = columns.has('daily_limit')
      ? `CASE
          WHEN typeof(daily_limit) IN ('integer', 'real')
            AND daily_limit >= 0
            AND daily_limit = CAST(daily_limit AS INTEGER)
            AND daily_limit <= 9007199254740991
          THEN CAST(daily_limit AS INTEGER)
          ELSE 0
        END`
      : '0'
    db.prepare(`
      UPDATE betting_accounts
      SET
        currency = 'CNY',
        amount_scale = 0,
        per_bet_limit_minor = ${legacyAmount},
        stake_step_minor = 1,
        allocation_status = 'paused'
    `).run()
  }
  db.prepare(`
    DELETE FROM betting_rule_leagues
    WHERE rule_id IN (SELECT id FROM betting_rules WHERE enabled = 0)
  `).run()
  db.prepare(`
    UPDATE betting_rules
    SET name = '手动预览规则'
    WHERE id = 'brule_manual'
       OR name IN ('Manual dry-run rule', 'portable dry-run rule')
  `).run()
  db.prepare(`
    UPDATE betting_rules
    SET archived = 1, enabled = 0, monitor_enabled = 0, real_betting_enabled = 0
    WHERE id = 'brule_manual'
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO betting_rules (
      id, name, priority, monitor_enabled, real_betting_enabled, archived,
      mode, period, market_type, monitored_side, min_water_rise,
      target_odds_min, target_odds_max, execution_mode, currency,
      amount_scale, target_amount_minor, migration_review_required,
      created_at, updated_at
    ) VALUES
      ('legacy-prematch', 'Legacy prematch migration template', 1, 0, 0, 0,
       'prematch', 'full', 'asian_handicap', 'home', '0.01', '0', '2',
       'preview_only', 'CNY', 0, 0, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
      ('legacy-live', 'Legacy live migration template', 1, 0, 0, 0,
       'live', 'full', 'asian_handicap', 'home', '0.01', '0', '2',
       'preview_only', 'CNY', 0, 0, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
  `).run()
  db.prepare(`
    UPDATE betting_rules
    SET created_at = CASE WHEN trim(created_at) = '' THEN '1970-01-01T00:00:00.000Z' ELSE created_at END,
        updated_at = CASE WHEN trim(updated_at) = '' THEN '1970-01-01T00:00:00.000Z' ELSE updated_at END
    WHERE trim(created_at) = '' OR trim(updated_at) = ''
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO real_betting_runtime (
      singleton_id, requested, runtime_state, reason_code, updated_at
    ) VALUES (1, 0, 'off', NULL, '')
  `).run()
  db.prepare(`
    UPDATE betting_accounts
    SET
      label = CASE
        WHEN id = 'bet_manual' OR label IN ('manual-dry-run', 'portable dry-run account', 'portable-dry-run') THEN '手动预览账号'
        ELSE label
      END,
      username = CASE
        WHEN id = 'bet_manual' OR username IN ('manual-dry-run', 'portable-dry-run') THEN '手动预览账号'
        ELSE username
      END
    WHERE id = 'bet_manual'
       OR label IN ('manual-dry-run', 'portable dry-run account', 'portable-dry-run')
       OR username IN ('manual-dry-run', 'portable-dry-run')
  `).run()
}

function readLegacyMonitorJson(value) {
  if (value === null) return null
  if (value !== undefined) return value
  try {
    return JSON.parse(fs.readFileSync(path.resolve('config/monitor-settings.json'), 'utf8'))
  } catch {
    return null
  }
}

function applyAlertBettingSettingsMigration(db, monitorJson) {
  const existingRows = {
    monitorSettings: db.prepare('SELECT mode, version FROM monitor_alert_settings').all(),
    autoBettingSettings: db.prepare('SELECT mode, version FROM auto_betting_settings').all(),
  }
  const legacyRules = db.prepare(`
    SELECT id, mode, archived, currency, amount_scale, target_odds_min, target_odds_max,
           target_amount_minor, migration_review_required, enabled, monitor_enabled,
           real_betting_enabled
    FROM betting_rules
  `).all()
  const decision = decideAlertBettingMigration({ monitorJson, legacyRules, existingRows })
  const now = new Date().toISOString()
  const insertMonitor = db.prepare(`
    INSERT INTO monitor_alert_settings (
      mode, enabled, asian_handicap_enabled, total_enabled, monitor_odds_min,
      monitor_odds_max, water_move_threshold, cooldown_seconds,
      start_minutes_before_kickoff, stop_minutes_before_kickoff,
      live_minute_from, live_minute_to, include_first_half, include_half_time,
      include_second_half, remark, migration_review_required,
      migration_review_reason, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)
  for (const row of decision.monitorSettings) {
    insertMonitor.run(
      row.mode, row.enabled, row.asian_handicap_enabled, row.total_enabled,
      row.monitor_odds_min, row.monitor_odds_max, row.water_move_threshold,
      row.cooldown_seconds, row.start_minutes_before_kickoff,
      row.stop_minutes_before_kickoff, row.live_minute_from, row.live_minute_to,
      row.include_first_half, row.include_half_time, row.include_second_half,
      row.remark, row.migration_review_required, row.migration_review_reason, now, now,
    )
  }
  const insertBetting = db.prepare(`
    INSERT INTO auto_betting_settings (
      mode, enabled, target_odds_min, target_odds_max, target_amount_minor,
      currency, amount_scale, remark, real_eligible, real_eligibility_version,
      real_eligibility_updated_at, migration_review_required,
      migration_review_reason, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 1, '', ?, ?, 1, ?, ?)
  `)
  for (const row of decision.autoBettingSettings) {
    insertBetting.run(
      row.mode, row.enabled, row.target_odds_min, row.target_odds_max,
      row.target_amount_minor, row.currency, row.amount_scale, row.real_eligible,
      row.migration_review_required, row.migration_review_reason, now, now,
    )
  }
}

function canonicalCreateTableSql(table, replacement) {
  const startMarker = `CREATE TABLE IF NOT EXISTS ${table} (`
  const start = SCHEMA.indexOf(startMarker)
  if (start < 0) throw new Error(`canonical-schema-missing:${table}`)
  const end = SCHEMA.indexOf('\n\nCREATE TABLE', start)
  const statement = SCHEMA.slice(start, end < 0 ? undefined : end).trim().replace(/;$/, '')
  return statement.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${replacement}`)
}

function tableSql(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || ''
}

function needsCanonicalRebuild(db, table) {
  const info = new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row]))
  const sql = tableSql(db, table)
  if (table === 'monitor_alert_settings') {
    return !info.has('water_move_threshold') || info.has('water_rise_threshold')
      || !sql.includes('typeof(water_move_threshold)')
  }
  if (table === 'auto_betting_settings') {
    return String(info.get('target_odds_min')?.type || '').toUpperCase() !== 'TEXT'
      || String(info.get('target_odds_max')?.type || '').toUpperCase() !== 'TEXT'
      || !sql.includes("typeof(target_odds_min) = 'text'")
      || !sql.includes("typeof(target_odds_max) = 'text'")
  }
  if (table === 'betting_rules') {
    return info.get('currency')?.dflt_value !== "'CNY'"
      || info.get('amount_scale')?.dflt_value !== '0'
      || !sql.includes("market_type IN ('asian_handicap','total')")
      || !sql.includes("mode IN ('prematch','live')")
      || !sql.includes("period IN ('full','first_half','second_half')")
      || !sql.includes("monitored_side IN ('home','away','over','under')")
      || !sql.includes("typeof(amount_scale) = 'integer'")
  }
  if (table === 'bet_batches' || table === 'bet_market_once_claims') {
    return info.get('rule_id')?.notnull !== 0
      || !sql.includes('rule_id IS NOT NULL AND betting_mode IS NULL AND settings_version IS NULL')
      || !sql.includes('rule_id IS NULL AND betting_mode IS NOT NULL AND settings_version IS NOT NULL')
      || !sql.includes('card_id IS NOT NULL AND card_version IS NOT NULL')
  }
  return info.get('currency')?.dflt_value !== "'CNY'"
    || info.get('amount_scale')?.dflt_value !== '0'
    || info.get('stake_step_minor')?.dflt_value !== '1'
    || !sql.includes("allocation_status IN ('enabled', 'pause_pending', 'paused', 'checking')")
    || !sql.includes("typeof(amount_scale) = 'integer'")
    || !sql.includes("typeof(stake_step_minor) = 'integer'")
}

function rebuildCanonicalTable(db, table) {
  const replacement = `${table}__canonical_rebuild`
  const sourceRows = table === 'auto_betting_settings' || table === 'monitor_alert_settings'
    ? db.prepare(`SELECT * FROM ${table}`).all()
    : null
  const canonicalSourceRows = sourceRows?.map((row) => table === 'auto_betting_settings'
    ? {
        ...row,
        target_odds_min: canonicalAutoBettingDecimal(row.target_odds_min),
        target_odds_max: canonicalAutoBettingDecimal(row.target_odds_max),
      }
    : { ...row, water_move_threshold: row.water_move_threshold ?? row.water_rise_threshold }) || null
  const schemaObjects = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all(table)
  db.exec(`DROP TABLE IF EXISTS ${replacement}`)
  db.exec(canonicalCreateTableSql(table, replacement))
  const sourceColumns = tableColumns(db, table)
  const columns = db.prepare(`PRAGMA table_info(${replacement})`).all()
    .map((row) => row.name)
    .filter((column) => sourceColumns.has(column)
      || (table === 'monitor_alert_settings' && column === 'water_move_threshold'))
  const names = columns.map((column) => `"${column}"`).join(', ')
  if (canonicalSourceRows) {
    const insert = db.prepare(`INSERT INTO ${replacement} (${names}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const row of canonicalSourceRows) {
      insert.run(...columns.map((column) => row[column]))
    }
  } else {
    db.exec(`INSERT INTO ${replacement} (${names}) SELECT ${names} FROM ${table}`)
  }
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`)
  for (const object of schemaObjects) {
    if (['bet_batches_settings_scope_safe_insert', 'bet_batches_settings_scope_safe_update',
      'bet_market_once_claims_settings_scope_safe_insert'].includes(object.name)) continue
    db.exec(object.sql)
  }
}

function applyCanonicalTableRebuilds(db) {
  const tables = [
    'monitor_alert_settings', 'auto_betting_settings', 'betting_rules', 'betting_accounts', 'bet_batches', 'bet_market_once_claims',
  ].filter((table) => needsCanonicalRebuild(db, table))
  if (!tables.length) return
  for (const table of tables) rebuildCanonicalTable(db, table)
  const violation = db.prepare('PRAGMA foreign_key_check').get()
  if (violation) throw new Error(`canonical-rebuild-foreign-key:${violation.table}`)
}

export function defaultDbPath(env = process.env) {
  if (env.CROWN_PORTABLE === '1') return resolvePortableDbPath(env.CROWN_DB_PATH, env)
  return path.resolve(env.CROWN_DB_PATH || DEFAULT_DB_PATH)
}

function portableDataRoot(env) {
  if (!env.CROWN_DATA_ROOT) throw new Error('portable-data-root-required')
  try {
    return assertPathWithin(env.CROWN_DATA_ROOT, env.CROWN_DATA_ROOT, 'dataRoot')
  } catch {
    throw new Error('portable-data-root-invalid')
  }
}

function resolvePortableDbPath(dbPath, env) {
  const dataRoot = portableDataRoot(env)
  if (!dbPath) throw new Error('portable-db-path-required')
  if (dbPath === ':memory:') throw new Error('portable-db-memory-forbidden')
  try {
    return assertPathWithin(dataRoot, dbPath, 'dbPath')
  } catch (error) {
    if (error?.code === 'portable-path-invalid') {
      throw new Error('portable-db-path-absolute-required')
    }
    throw error
  }
}

function resolveDbPath(dbPath, env) {
  if (env.CROWN_PORTABLE === '1') {
    return resolvePortableDbPath(dbPath ?? env.CROWN_DB_PATH, env)
  }
  if (dbPath === undefined) return defaultDbPath(env)
  if (dbPath === ':memory:') return dbPath
  return path.resolve(dbPath)
}

export function readAppSchemaVersion({ dbPath, env = process.env } = {}) {
  const resolvedPath = resolveDbPath(dbPath, env)
  if (resolvedPath === ':memory:' || !fs.existsSync(resolvedPath)) return null
  let db
  try {
    db = new DatabaseSync(resolvedPath, { readOnly: true })
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='app_schema_meta'").get()
    if (!table) return null
    const value = db.prepare("SELECT meta_value FROM app_schema_meta WHERE meta_key='schema_contract'").get()?.meta_value
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

export function openRuntimeDatabase({ dbPath, env = process.env } = {}) {
  const resolvedPath = resolveDbPath(dbPath, env)
  if (resolvedPath !== ':memory:' && !fs.existsSync(resolvedPath)) {
    throw new Error(`app database does not exist: ${resolvedPath}`)
  }
  const db = new DatabaseSync(resolvedPath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA recursive_triggers = ON')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  } catch (error) {
    db.close()
    throw error
  }
  return {
    db,
    dbPath: resolvedPath,
    close() {
      db.close()
    },
  }
}

export function openAppDatabase({ dbPath, env = process.env, monitorJson } = {}) {
  const resolvedPath = resolveDbPath(dbPath, env)
  if (resolvedPath !== ':memory:') fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })

  const db = new DatabaseSync(resolvedPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA recursive_triggers = ON')
  db.exec('PRAGMA journal_mode = WAL')
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    db.exec(SCHEMA)
    db.prepare(`INSERT INTO app_schema_meta(meta_key, meta_value)
      VALUES ('schema_contract', ?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value`).run(APP_CONTRACT_VERSION)
    assertLegacyExecutionAuthorizationsSafe(db)
    const addedColumns = applyMigrations(db)
    migrateInboxCompositeIdentity(db)
    assertLegacyExecutionAuthorizationsSafe(db)
    applyExecutionAuthorizationGuards(db)
    applyDataMigrations(db, addedColumns)
    applyCanonicalTableRebuilds(db)
    applySeparatedExecutionScopeGuards(db)
    applyAuthorizationScopeGuards(db)
    applyAlertBettingSettingsMigration(db, readLegacyMonitorJson(monitorJson))
    const fixedCardMigration = db.prepare(`SELECT 1 FROM app_schema_meta
      WHERE meta_key='fixed_settings_rule_card_migration_completed'`).get()
    if (!fixedCardMigration) {
      migrateFixedSettingsToRuleCards(db)
      db.prepare(`INSERT INTO app_schema_meta(meta_key,meta_value)
        VALUES ('fixed_settings_rule_card_migration_completed','1')`).run()
    }
    const foreignKeyViolation = db.prepare('PRAGMA foreign_key_check').get()
    if (foreignKeyViolation) throw new Error(`app-db-foreign-key:${foreignKeyViolation.table}`)
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // BEGIN may itself have failed, leaving no transaction to roll back.
    }
    db.close()
    throw error
  }

  return {
    db,
    dbPath: resolvedPath,
    close() {
      db.close()
    },
  }
}
