# bot_accounts.session_data envelope encryption (Wave 2 task E)

Every row in `bot_accounts.session_data` is a v1 AES-256-GCM envelope:

```
v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
```

The plaintext payload is the Playwright storage-state JSON
(`{ cookies: [...], origins: [...] }`). A DB leak alone does NOT give an
attacker a working bot session — they'd need the key too.

## Key material: `SESSION_DATA_KEY`

32 random bytes, base64-encoded, exported as an env var:

```bash
# Generate a new key (one-time):
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'

# Set it in .env or PM2 ecosystem file, then:
pm2 reload cheaterfinder --update-env
```

Validated at boot by `server/index.ts`:
- Production: missing/invalid key → process.exit(1)
- Development: logs warning and continues (plaintext path still works)

## Migration (one-time)

Any row stored before Wave 2 is plaintext. There is NO separate migration
script. The lazy-encrypt-on-read path in `server/bot-manager.ts`
(`getAcceptedBotSession`) detects plaintext and fires a background UPDATE
to replace the row with a v1 envelope. This means:

- Bots that are actively used get migrated within one job cycle.
- Idle bots stay plaintext until the next read. That's OK — the admin
  can force re-encryption by calling `PUT /api/admin/bots/:id` with the
  same sessionData, which always writes the v1 envelope.

Verify migration progress in SQL:

```sql
SELECT
  COUNT(*) FILTER (WHERE session_data LIKE 'v1:%') AS encrypted,
  COUNT(*) FILTER (WHERE session_data NOT LIKE 'v1:%') AS plaintext
FROM bot_accounts;
```

## Key rotation

There is no key-id in the current envelope (the `v1` prefix is a format
version, not a key version). Rotation is a manual dance:

1. Generate NEW key, keep OLD key set as `SESSION_DATA_KEY_OLD`.
2. Patch `server/crypto/session-envelope.ts` temporarily so `decryptSessionData`
   tries the new key first, falls back to the old. Redeploy.
3. Run a one-time script that reads every `bot_accounts` row, decrypts with
   old, encrypts with new, writes back.
4. Remove `SESSION_DATA_KEY_OLD` and the fallback code. Redeploy.

A future iteration should add `v2:<key-id>:...` with key-id in the envelope
so rotation doesn't require code changes; defer until we need it.

## Incident playbook

If the key leaks:

1. Generate a new key.
2. Rotate per above, treating ALL bots as compromised.
3. Run `UPDATE bot_accounts SET status = 'banned'` and force a full
   manual re-auth of every bot via `PUT /api/admin/bots/:id` with a
   freshly captured storageState.
4. File an incident ticket; audit the key-leak path.

If the DB leaks but the key does not:

- Plaintext rows ARE exposed. Immediately `UPDATE` to force re-auth on
  any plaintext-ever bot. Verify with the SQL above that no row has
  `session_data NOT LIKE 'v1:%'`.
- Encrypted rows are safe as long as the key has not leaked.
