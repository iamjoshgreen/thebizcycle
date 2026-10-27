-- Run AFTER the admin user exists (server seeds it on first boot).
-- Moves legacy rows to the admin and installs the per-user primary keys.
BEGIN;
UPDATE settings SET user_id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) WHERE user_id IS NULL;
UPDATE drawings SET user_id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) WHERE user_id IS NULL;
DELETE FROM settings WHERE user_id IS NULL;
DELETE FROM drawings WHERE user_id IS NULL;
ALTER TABLE settings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE drawings ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='settings'::regclass AND contype='p' AND conname <> 'settings_user_key_pk') THEN
    EXECUTE (SELECT 'ALTER TABLE settings DROP CONSTRAINT ' || conname FROM pg_constraint WHERE conrelid='settings'::regclass AND contype='p');
    ALTER TABLE settings ADD CONSTRAINT settings_user_key_pk PRIMARY KEY (user_id, key);
    ALTER TABLE settings ADD CONSTRAINT settings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='drawings'::regclass AND contype='p' AND conname <> 'drawings_user_pk') THEN
    EXECUTE (SELECT 'ALTER TABLE drawings DROP CONSTRAINT ' || conname FROM pg_constraint WHERE conrelid='drawings'::regclass AND contype='p');
    ALTER TABLE drawings DROP COLUMN IF EXISTS id;
    ALTER TABLE drawings ADD CONSTRAINT drawings_user_pk PRIMARY KEY (user_id);
    ALTER TABLE drawings ADD CONSTRAINT drawings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
COMMIT;
