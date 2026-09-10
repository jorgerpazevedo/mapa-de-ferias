ALTER TABLE employees ADD COLUMN tags TEXT;

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'nota',
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'concluido',
  impact TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_employee ON activities(employee_id);
