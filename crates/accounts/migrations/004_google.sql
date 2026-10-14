-- Google login: link a Google identity to a Songnest account.
--
-- Same rules as GitHub (003_github.sql): users created via OAuth have
-- `password_hash IS NULL` and are identified by `google_sub`. A matching
-- email links the Google identity onto the existing row.

ALTER TABLE users ADD COLUMN google_sub TEXT UNIQUE;
CREATE INDEX users_google_sub_idx ON users (google_sub);
