-- Public user handles.
--
-- One row per (user, username) ever claimed: history is kept so released
-- names stay reserved (no impersonation by re-registering someone's old
-- handle). The current handle is the latest row per user
-- (`ORDER BY created_at DESC, id DESC LIMIT 1`).
--
-- Uniqueness is case-insensitive (`lower(username)`): "SmasDuq" and
-- "smasduq" are the same handle. Display keeps the original casing.

CREATE TABLE usernames (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usernames_username_unique_idx ON usernames (lower(username));
CREATE INDEX usernames_user_idx ON usernames (user_id);
