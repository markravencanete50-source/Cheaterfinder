-- C2 fix: role-based admin authorization.
-- Adds a role column to users (default 'user') and promotes the existing
-- operator account to 'admin'. After this migration, isAdmin checks
-- users.role instead of comparing the (user-editable) email column against
-- the ADMIN_EMAIL env var, closing the "re-register the freed admin email
-- and become admin" hole.
--
-- Ordering note: this migration must be applied BEFORE deploying the code
-- that references users.role. The currently running build never reads the
-- column, so applying this migration under the live process is safe.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role varchar(16) NOT NULL DEFAULT 'user';

-- Promote the current operator account (ADMIN_EMAIL in .env at the time this
-- migration was written: admin@cheaterfinder.com). Idempotent: only flips a row that
-- is still 'user', and only if no admin has been designated yet.
UPDATE users
SET role = 'admin', updated_at = NOW()
WHERE email = 'admin@cheaterfinder.com'
  AND role = 'user'
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
