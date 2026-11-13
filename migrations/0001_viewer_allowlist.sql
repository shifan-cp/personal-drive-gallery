CREATE TABLE allowed_viewers (
  email TEXT PRIMARY KEY NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (email = lower(email)),
  CHECK (email LIKE '%@gmail.com')
);
