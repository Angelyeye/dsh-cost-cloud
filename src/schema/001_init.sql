-- ============================================================
-- dsh-cost-cloud schema v1（迁移由 PRAGMA user_version 驱动）
--
-- 统计维度：每条记录带 (device_id, source, agent_instance)，
-- 因此「每台设备 × 每个 agent」可独立统计、筛选、导出。
-- 记录分两类：kind='detail'（明细）与 kind='rollup'（日汇总快照），
-- 两者共用一张表 —— 聚合查询只需一条 SQL，天然避免口径分叉。
-- ============================================================

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  name_locked   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  last_ingest_at INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT ''
);

-- 令牌独立成表：同一设备可有多枚（轮换期并存），轮换只影响新令牌
CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tokens_device ON tokens(device_id);

-- 一行 = 一台设备上的一个 agent 实例
CREATE TABLE IF NOT EXISTS sources (
  device_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  agent_instance  TEXT NOT NULL DEFAULT '',
  display_name    TEXT NOT NULL DEFAULT '',
  agent_version   TEXT NOT NULL DEFAULT '',
  plugin_version  TEXT NOT NULL DEFAULT '',
  sync_ver        INTEGER NOT NULL DEFAULT 1,
  first_seen_at   INTEGER NOT NULL DEFAULT 0,
  last_seen_at    INTEGER NOT NULL DEFAULT 0,
  last_ingest_at  INTEGER NOT NULL DEFAULT 0,
  clock_skew_ms   INTEGER NOT NULL DEFAULT 0,
  max_client_seq  INTEGER NOT NULL DEFAULT 0,
  reset_epoch     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, source, agent_instance)
);

CREATE TABLE IF NOT EXISTS records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  agent_instance  TEXT NOT NULL DEFAULT '',
  dedup_key       TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'detail',      -- detail | rollup
  ts              INTEGER NOT NULL DEFAULT 0,
  day_key         TEXT NOT NULL,
  month_key       TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  session_id      TEXT NOT NULL DEFAULT '',
  purpose         TEXT NOT NULL DEFAULT '',
  calls           INTEGER NOT NULL DEFAULT 1,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  cost            REAL NOT NULL DEFAULT 0,             -- 入账费用（设备上报值优先）
  cost_recomputed REAL NOT NULL DEFAULT 0,             -- 云端按计费时代重算值（漂移对比用）
  device_cost     REAL,                                -- 上报值（可空）
  cost_drift      REAL NOT NULL DEFAULT 0,
  cost_basis      TEXT NOT NULL DEFAULT 'unknown',     -- reported | estimated | subscription | unknown
  peak            REAL NOT NULL DEFAULT 0,
  off             REAL NOT NULL DEFAULT 0,
  flat            REAL NOT NULL DEFAULT 0,
  subscription    INTEGER NOT NULL DEFAULT 0,
  estimated       INTEGER NOT NULL DEFAULT 0,
  period          TEXT NOT NULL DEFAULT 'flat',
  client_seq      INTEGER,
  sync_ver        INTEGER NOT NULL DEFAULT 1,
  batch_uid       TEXT NOT NULL DEFAULT '',
  received_at     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL DEFAULT 0,
  meta            TEXT NOT NULL DEFAULT '',
  UNIQUE (device_id, source, agent_instance, dedup_key)
);

CREATE INDEX IF NOT EXISTS ix_records_day ON records(day_key);
CREATE INDEX IF NOT EXISTS ix_records_device_source_ts ON records(device_id, source, ts);
CREATE INDEX IF NOT EXISTS ix_records_source_ts ON records(source, ts);
CREATE INDEX IF NOT EXISTS ix_records_ts ON records(ts);
CREATE INDEX IF NOT EXISTS ix_records_model ON records(provider, model);
CREATE INDEX IF NOT EXISTS ix_records_session ON records(session_id);
CREATE INDEX IF NOT EXISTS ix_records_kind ON records(kind);
CREATE INDEX IF NOT EXISTS ix_records_device_day ON records(device_id, day_key);

CREATE TABLE IF NOT EXISTS tombstones (
  device_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  agent_instance  TEXT NOT NULL DEFAULT '',
  dedup_key       TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (device_id, source, agent_instance, dedup_key)
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  agent_instance TEXT NOT NULL DEFAULT '',
  batch_uid     TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  accepted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  duplicates    INTEGER NOT NULL DEFAULT 0,
  invalid       INTEGER NOT NULL DEFAULT 0,
  tombstoned    INTEGER NOT NULL DEFAULT 0,
  ip            TEXT NOT NULL DEFAULT '',
  UNIQUE (device_id, source, agent_instance, batch_uid)
);
CREATE INDEX IF NOT EXISTS ix_batches_received ON ingest_batches(received_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL DEFAULT '',
  detail  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
