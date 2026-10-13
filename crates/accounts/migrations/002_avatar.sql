-- Per-user profile picture: Neon Object Storage key. The bytes live in
-- the `songnest-bucket` bucket (`avatars/<user_id>/<uuid>.<ext>`); only
-- the key is stored here so files and rows branch together.
ALTER TABLE users ADD COLUMN avatar_key TEXT;
