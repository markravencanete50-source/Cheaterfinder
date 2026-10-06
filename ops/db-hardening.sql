-- Fix #18: DB role over-privileged
-- Run these once as a PostgreSQL superuser (e.g. `postgres`) after migrations
-- have been applied. The application role (`cheaterfinder`) only needs
-- SELECT/INSERT/UPDATE/DELETE/USAGE on public.*. It should not be able to
-- create databases or drop tables.
--
-- Example:
--   sudo -u postgres psql cheaterfinder_ai -f ops/db-hardening.sql

ALTER ROLE cheaterfinder NOCREATEDB;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM cheaterfinder;
