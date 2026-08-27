// One-off script: generates seed.sql with securely hashed passwords for the
// initial admin/admin and user/user accounts. Run with: node scripts/gen-seed.mjs
import { writeFileSync } from 'node:fs';

const ITERATIONS = 100000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(bits);
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function seedRow(id, name, startDate, contact, username, password, role) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  return `INSERT INTO employees (id, name, start_date, contact, username, password_hash, password_salt, role, vacation_days_total, sick_days_total) VALUES ('${id}', '${name.replace(/'/g, "''")}', '${startDate}', '${contact}', '${username}', '${hash}', '${salt}', '${role}', 22, 3);`;
}

const lines = [];
lines.push(await seedRow('e1', 'Administrador', '2024-01-08', 'geral@empresa.pt', 'admin', 'admin', 'gestor'));
lines.push(await seedRow('e2', 'Colaborador Exemplo', '2025-03-03', 'colaborador@empresa.pt', 'user', 'user', 'colaborador'));

writeFileSync(new URL('../seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log('seed.sql gerado com', lines.length, 'contas.');
