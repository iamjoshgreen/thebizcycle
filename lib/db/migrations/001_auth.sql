-- Accounts, sessions, site config; scope settings + drawings per user.
-- Idempotent. Existing settings/drawings rows are assigned to the first admin.
BEGIN;
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  active boolean NOT NULL DEFAULT true,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_config(key, value) VALUES ('require_subscription', 'false') ON CONFLICT DO NOTHING;

-- settings: (key) -> (user_id, key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='user_id') THEN
    ALTER TABLE settings ADD COLUMN user_id integer;
  END IF;
END $$;
-- drawings: (id) -> (user_id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drawings' AND column_name='user_id') THEN
    ALTER TABLE drawings ADD COLUMN user_id integer;
  END IF;
END $$;
COMMIT;
