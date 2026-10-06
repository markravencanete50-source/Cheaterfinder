BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS delivery_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS bandwidth_log_delivery_id_key ON bandwidth_log(delivery_id);
ALTER TABLE proxy_wire_samples ADD COLUMN IF NOT EXISTS sample_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS proxy_wire_samples_sample_key_key ON proxy_wire_samples(sample_key);
COMMIT;
