-- Persist notification preferences server-side.
--
-- PROBLEM
--   The Settings page's "Email Alerts" and "Push Notifications" toggles were
--   stored ONLY in localStorage (pref_emailAlerts / pref_pushNotifications).
--   The server never learned them, so:
--     - the weekly report EMAIL was sent unconditionally — turning "Email Alerts"
--       off did nothing;
--     - the preference didn't follow the user across devices.
--
-- FIX
--   Store both as columns on the user. Defaults match the previous client
--   defaults exactly, so existing users see no behaviour change until they opt
--   out: email on, push off.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_alerts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_notifications boolean NOT NULL DEFAULT false;
