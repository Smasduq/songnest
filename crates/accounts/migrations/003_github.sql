-- GitHub login: link a GitHub user to a Songnest account.
--
-- Existing email+password users keep `password_hash`. Users created via
-- "Login with GitHub" have no password (`password_hash IS NULL`) and are
-- identified by `github_id`. When a GitHub email matches an existing
-- password account, the login flow links `github_id` onto that row instead
-- of creating a duplicate.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN github_id BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN github_login TEXT;
CREATE INDEX users_github_id_idx ON users (github_id);
