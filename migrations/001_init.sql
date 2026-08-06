-- Joule store schema — request log (Phase 0.1: persistent Postgres backing).
-- Idempotent: safe to run on every boot. Mirrors what store.js persists today —
-- the append-only request log (full record as JSONB) plus the async verification
-- result attached later. Sessions / daily rollups / per-model remain COMPUTED in
-- JS from these rows, so the numbers reconcile exactly with the JSONL backend.

CREATE TABLE IF NOT EXISTS records (
  seq          BIGSERIAL PRIMARY KEY,       -- append order (parity with JSONL line order)
  id           TEXT UNIQUE NOT NULL,        -- store-assigned record id
  ts           TIMESTAMPTZ,                 -- record timestamp (may be backdated in tests)
  tier         TEXT,                        -- "small" | "large"
  mode         TEXT,                        -- "dry_run" | "live" | "cache" | "semantic_cache" | ...
  model        TEXT,
  session      TEXT,                        -- client X-Joule-Session (nullable)
  cached       BOOLEAN,
  data         JSONB NOT NULL,              -- the full request record (snapshot at add() time)
  verification JSONB,                       -- async verification result (attached later)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_ts_idx      ON records (ts);
CREATE INDEX IF NOT EXISTS records_session_idx ON records (session);
