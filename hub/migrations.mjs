/**
 * Hub registry schema (task 4.1).
 *
 * Blocks (coordinates, parent+sponsor edges, dynasty, defaced flag), joins
 * (typed state, monotonic revision, pinned payer, scoped capability,
 * soft/hard quotes, disclosure hashes, attached payment identities),
 * positions (per-ancestor tribute plan + settlement), the canonical public
 * event log (D11), the public ledger, and seasons.
 *
 * Trust root (spec: "Chain evidence is the sole funds-moving trust root"):
 * the partial unique index on settled transaction_ref enforces
 * once-per-season transaction consumption; payment_id is correlation only.
 */
export const HUB_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS giza_seasons (
  id INT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed')),
  courses INT NOT NULL DEFAULT 9,
  block_cap INT NOT NULL DEFAULT 500,
  seal_date TIMESTAMPTZ,
  sealed_at TIMESTAMPTZ,
  disclosure_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO giza_seasons (id, courses, block_cap) VALUES (1, 9, 500) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS giza_blocks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id INT NOT NULL REFERENCES giza_seasons(id),
  course INT NOT NULL,
  position_in_course INT NOT NULL,
  parent_block_id BIGINT REFERENCES giza_blocks(id),
  sponsor_block_id BIGINT REFERENCES giza_blocks(id),
  dynasty TEXT,
  owner_wallet TEXT NOT NULL,
  payout_wallet TEXT NOT NULL,
  base_url TEXT NOT NULL,
  host TEXT NOT NULL,
  inscription TEXT,
  defaced BOOLEAN NOT NULL DEFAULT false,
  is_pharaoh BOOLEAN NOT NULL DEFAULT false,
  join_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (season_id, course, position_in_course)
);
CREATE UNIQUE INDEX IF NOT EXISTS giza_blocks_host ON giza_blocks (lower(host));

CREATE TABLE IF NOT EXISTS giza_joins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id INT NOT NULL REFERENCES giza_seasons(id),
  state TEXT NOT NULL DEFAULT 'quoted' CHECK (state IN (
    'quoted','block_attached','health_checked','reserved','accepted',
    'paying','reconciling','finalized','cancelled','expired','halted_reconsent')),
  revision INT NOT NULL DEFAULT 1,
  payer_wallet TEXT NOT NULL,
  sponsor_block_id BIGINT NOT NULL REFERENCES giza_blocks(id),
  capability_hash TEXT NOT NULL,
  disclosure_version INT NOT NULL,
  soft_disclosure_hash TEXT NOT NULL,
  hard_disclosure_hash TEXT,
  accepted_at TIMESTAMPTZ,
  soft_quote JSONB NOT NULL,
  hard_quote JSONB,
  plan_version INT NOT NULL DEFAULT 0,
  parent_block_id BIGINT REFERENCES giza_blocks(id),
  reserved_course INT,
  block_base_url TEXT,
  block_host TEXT,
  block_payout_wallet TEXT,
  inscription TEXT,
  dynasty TEXT,
  finalized_block_id BIGINT,
  cancel_reason TEXT,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS giza_joins_parent_active ON giza_joins (parent_block_id)
  WHERE state IN ('reserved','accepted','paying','reconciling');

CREATE TABLE IF NOT EXISTS giza_join_positions (
  join_id UUID NOT NULL REFERENCES giza_joins(id) ON DELETE CASCADE,
  plan_version INT NOT NULL,
  position INT NOT NULL,
  ancestor_block_id BIGINT NOT NULL REFERENCES giza_blocks(id),
  amount_usd_micros BIGINT NOT NULL,
  caller_key TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  tribute_url TEXT NOT NULL,
  payment_id TEXT,
  transaction_ref TEXT,
  settled BOOLEAN NOT NULL DEFAULT false,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (join_id, plan_version, position)
);
-- Once-per-season transaction consumption: THE substitution guard.
CREATE UNIQUE INDEX IF NOT EXISTS giza_tx_consumed
  ON giza_join_positions (lower(transaction_ref)) WHERE settled;

-- D11: the hub-owned canonical, append-only public log.
CREATE TABLE IF NOT EXISTS giza_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL,
  unique_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS giza_events_type ON giza_events (type, id);

-- Public per-tribute ledger: chain-anchored rows any visitor can verify.
CREATE TABLE IF NOT EXISTS giza_ledger (
  payment_id TEXT PRIMARY KEY,
  join_id UUID,
  position INT,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  amount_usd_micros BIGINT NOT NULL,
  asset TEXT,
  network TEXT,
  transaction_ref TEXT NOT NULL,
  block_id BIGINT,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;
