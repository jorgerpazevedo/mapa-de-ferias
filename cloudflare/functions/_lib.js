const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
}

export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(bits);
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const actual = await hashPassword(password, saltHex);
  if (actual.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  return diff === 0;
}

export function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init && init.headers) },
  });
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const attrs = [`session=${token}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  attrs.push(`Max-Age=${maxAgeSeconds}`);
  return attrs.join('; ');
}

export function clearSessionCookie() {
  return 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export async function createSession(db, employeeId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare('INSERT INTO sessions (token, employee_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, employeeId, expires)
    .run();
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function currentEmployee(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT e.* FROM sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

export function publicEmployee(e) {
  return {
    id: e.id,
    name: e.name,
    startDate: e.start_date,
    contact: e.contact,
    username: e.username,
    role: e.role,
    vacationDaysTotal: e.vacation_days_total,
    sickDaysTotal: e.sick_days_total,
  };
}

export function publicLeave(l, employeeName) {
  return {
    id: l.id,
    employeeId: l.employee_id,
    employeeName: employeeName,
    type: l.type,
    start: l.start_date,
    end: l.end_date,
    days: l.days,
    status: l.status,
    respondedBy: l.responded_by,
    respondedAt: l.responded_at,
    createdAt: l.created_at,
  };
}

export function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function calendarDays(startIso, endIso) {
  return Math.round((parseIso(endIso) - parseIso(startIso)) / 86400000) + 1;
}

export function businessDays(startIso, endIso) {
  const s = parseIso(startIso), e = parseIso(endIso);
  if (e < s) return 0;
  let count = 0;
  const d = new Date(s);
  while (d <= e) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return parseIso(aStart) <= parseIso(bEnd) && parseIso(bStart) <= parseIso(aEnd);
}

export function uid(prefix) {
  return prefix + randomHex(6);
}
