-- 0047: kernel-measured proxy gateway wire traffic (bandwidth audit 2026-09-04).
--
-- The admin bandwidth panel reported 7.4 GB over 7 days while the proxy
-- provider billed ~57 GB over 5 days. `bandwidth_log` is not wrong, it answers
-- a different question: it is per-REQUEST ATTRIBUTION (which user / which
-- tracked profile / which endpoint), measured from inside Node, where it can
-- only see a DECODED response body. Two structural blind spots make it useless
-- as a bill estimate:
--   1. Browser-lane reads launch a real Firefox that loads a full
--      instagram.com page (~5-7 MB on the wire) before it issues the API
--      fetch. That page load never passes through Node and was counted as 0.
--   2. HTTP/mobile JSON is counted decoded; IG gzips ~5-8x on the wire, so
--      those rows over-state their own transfer.
--
-- This table holds the OTHER number: what the provider actually bills. A
-- pure-counter iptables rule per gateway IP (no `-j` target, so it counts and
-- falls through — it filters nothing) accumulates every TCP byte to and from
-- the proxy gateway; server/services/proxy-wire-sampler.ts reads those kernel
-- counters on a timer and stores the DELTA between consecutive reads. Rows are
-- deltas, not running totals, so a windowed SUM is the transfer in that window.
--
-- span_seconds is the wall time the row covers, which makes partial coverage
-- visible: after a restart or a fresh install the first sample is only a
-- baseline (no row), so SUM(span_seconds) < the report window means the number
-- is a floor, not a total.
--
-- Deliberately unrelated to bandwidth_log: no user, profile or endpoint column
-- exists or can exist here — the kernel sees packets, not scrape context. The
-- panel shows both side by side (billable wire vs. attributed payload).
--
-- Mirrored by an ensureTable() CREATE TABLE IF NOT EXISTS in
-- proxy-wire-sampler.ts so a boot never depends on this migration having run.
-- Keep the two definitions in sync.
CREATE TABLE IF NOT EXISTS proxy_wire_samples (
  id bigserial PRIMARY KEY,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  bytes_in bigint NOT NULL DEFAULT 0,
  bytes_out bigint NOT NULL DEFAULT 0,
  span_seconds integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS proxy_wire_samples_sampled_at_idx
  ON proxy_wire_samples (sampled_at);

COMMENT ON TABLE proxy_wire_samples IS
  'Kernel-measured (iptables byte counters) billable traffic to the proxy gateway. One row per sampling interval, holding the DELTA since the previous sample — not a running total.';
COMMENT ON COLUMN proxy_wire_samples.bytes_in IS
  'Encoded TCP bytes received FROM the proxy gateway during this interval (INPUT chain, -s gateway).';
COMMENT ON COLUMN proxy_wire_samples.bytes_out IS
  'Encoded TCP bytes sent TO the proxy gateway during this interval (OUTPUT chain, -d gateway).';
COMMENT ON COLUMN proxy_wire_samples.span_seconds IS
  'Wall seconds this delta covers. Summed over a report window it shows how much of the window is actually measured; 0 on the first row after a counter reset.';
