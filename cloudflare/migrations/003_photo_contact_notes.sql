ALTER TABLE employees ADD COLUMN email TEXT;
ALTER TABLE employees ADD COLUMN phone TEXT;
ALTER TABLE employees ADD COLUMN notes TEXT;
ALTER TABLE employees ADD COLUMN photo TEXT;
UPDATE employees SET email = contact WHERE contact LIKE '%@%';
UPDATE employees SET phone = contact WHERE contact IS NOT NULL AND contact != '' AND contact NOT LIKE '%@%';
