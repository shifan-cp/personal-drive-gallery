CREATE TABLE media_likes (
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_admin INTEGER NOT NULL CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (file_id, user_id)
);

CREATE INDEX media_likes_file_id_idx ON media_likes (file_id);
