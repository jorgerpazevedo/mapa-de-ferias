ALTER TABLE employees ADD COLUMN job_title TEXT;
ALTER TABLE employees ADD COLUMN contract_type TEXT NOT NULL DEFAULT 'efetivo';
ALTER TABLE employees ADD COLUMN contract_end TEXT;
