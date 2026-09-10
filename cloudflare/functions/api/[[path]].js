import {
  json, parseCookies, sessionCookie, clearSessionCookie, createSession, currentEmployee,
  hashPassword, verifyPassword, randomHex, publicEmployee, publicLeave, publicActivity,
  publicAnnouncement, publicMessage,
  businessDays, calendarDays, rangesOverlap, uid,
} from '../_lib.js';

function thisYear() {
  return new Date().getFullYear();
}

const CONTRACT_TYPES = ['efetivo', 'termo_certo', 'termo_incerto', 'prestacao_servicos', 'estagio'];
function normalizeContractType(v) {
  return CONTRACT_TYPES.includes(v) ? v : 'efetivo';
}

async function computeBalances(db, employeeId) {
  const year = thisYear();
  const rows = await db.prepare(
    `SELECT type, status, days FROM leaves WHERE employee_id = ? AND substr(start_date,1,4) = ?`
  ).bind(employeeId, String(year)).all();
  const sums = { ferias: { aprovado: 0, pendente: 0 }, baixa: { aprovado: 0, pendente: 0 } };
  for (const r of rows.results) {
    if (r.status === 'aprovado' || r.status === 'pendente') sums[r.type][r.status] += r.days;
  }
  return sums;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) return json({ error: 'Utilizador e palavra-passe são obrigatórios.' }, { status: 400 });

  const emp = await env.DB.prepare('SELECT * FROM employees WHERE username = ?').bind(username).first();
  if (!emp || !(await verifyPassword(password, emp.password_salt, emp.password_hash))) {
    return json({ error: 'Utilizador ou palavra-passe incorretos.' }, { status: 401 });
  }
  const { token, maxAge } = await createSession(env.DB, emp.id);
  return json({ ok: true, me: publicEmployee(emp) }, { headers: { 'Set-Cookie': sessionCookie(token, maxAge) } });
}

async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  if (cookies.session) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(cookies.session).run();
  }
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
}

async function loadAnnouncements(env) {
  const rows = await env.DB.prepare(
    `SELECT a.*, c.name AS creator_name FROM announcements a LEFT JOIN employees c ON c.id = a.created_by ORDER BY a.created_at DESC LIMIT 30`
  ).all();
  return rows.results.map((a) => publicAnnouncement(a, a.creator_name));
}

async function handleState(request, env, me) {
  const announcements = await loadAnnouncements(env);
  if (me.role === 'gestor') {
    const empRows = await env.DB.prepare('SELECT * FROM employees ORDER BY name').all();
    const leaveRows = await env.DB.prepare('SELECT * FROM leaves ORDER BY start_date').all();
    const msgRows = await env.DB.prepare(
      `SELECT m.*, e.name AS employee_name, r.name AS responder_name FROM messages m
       LEFT JOIN employees e ON e.id = m.employee_id LEFT JOIN employees r ON r.id = m.responded_by
       ORDER BY m.created_at DESC`
    ).all();
    const nameById = {};
    empRows.results.forEach((e) => { nameById[e.id] = e.name; });
    return json({
      role: 'gestor',
      me: { ...publicEmployee(me), balances: await computeBalances(env.DB, me.id) },
      employees: await Promise.all(empRows.results.map(async (e) => ({
        ...publicEmployee(e),
        balances: await computeBalances(env.DB, e.id),
      }))),
      leaves: leaveRows.results.map((l) => publicLeave(l, nameById[l.employee_id], l.responded_by ? nameById[l.responded_by] : null)),
      announcements,
      messages: msgRows.results.map((m) => publicMessage(m, m.employee_name, m.responder_name)),
    });
  }
  const leaveRows = await env.DB.prepare(
    `SELECT l.*, r.name AS responder_name FROM leaves l LEFT JOIN employees r ON r.id = l.responded_by WHERE l.employee_id = ? ORDER BY l.start_date`
  ).bind(me.id).all();
  const msgRows = await env.DB.prepare(
    `SELECT m.*, r.name AS responder_name FROM messages m LEFT JOIN employees r ON r.id = m.responded_by WHERE m.employee_id = ? ORDER BY m.created_at DESC`
  ).bind(me.id).all();
  return json({
    role: 'colaborador',
    me: { ...publicEmployee(me), balances: await computeBalances(env.DB, me.id) },
    leaves: leaveRows.results.map((l) => publicLeave(l, me.name, l.responder_name)),
    announcements,
    messages: msgRows.results.map((m) => publicMessage(m, me.name, m.responder_name)),
  });
}

async function handleCreateLeave(request, env, me) {
  const body = await request.json().catch(() => ({}));
  const targetId = me.role === 'gestor' && body.employeeId ? body.employeeId : me.id;
  const target = targetId === me.id ? me : await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(targetId).first();
  if (!target) return json({ error: 'Colaborador não encontrado.' }, { status: 404 });

  const type = body.type === 'baixa' ? 'baixa' : 'ferias';
  const start = body.start, end = body.end;
  if (!start || !end || new Date(end) < new Date(start)) {
    return json({ error: 'Intervalo de datas inválido.' }, { status: 400 });
  }
  const days = type === 'ferias' ? businessDays(start, end) : calendarDays(start, end);
  if (days <= 0) return json({ error: 'O intervalo escolhido não tem dias úteis.' }, { status: 400 });

  const existing = await env.DB.prepare(
    `SELECT start_date, end_date FROM leaves WHERE employee_id = ? AND status != 'rejeitado'`
  ).bind(target.id).all();
  if (existing.results.some((l) => rangesOverlap(start, end, l.start_date, l.end_date))) {
    return json({ error: 'Já existe uma ausência marcada ou pendente nesse período.' }, { status: 409 });
  }

  if (type === 'ferias') {
    const year = thisYear();
    const usedRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(days),0) AS d FROM leaves WHERE employee_id = ? AND type = 'ferias' AND status IN ('aprovado','pendente') AND substr(start_date,1,4) = ?`
    ).bind(target.id, String(year)).first();
    if ((usedRow.d || 0) + days > target.vacation_days_total) {
      return json({ error: `Saldo insuficiente: restam ${target.vacation_days_total - (usedRow.d || 0)} dias de férias.` }, { status: 409 });
    }
  }

  const isAuto = me.role === 'gestor';
  const id = uid('l');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO leaves (id, employee_id, type, start_date, end_date, days, status, responded_by, responded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, target.id, type, start, end, days, isAuto ? 'aprovado' : 'pendente', isAuto ? me.id : null, isAuto ? now : null, now).run();

  return json({ ok: true, id, status: isAuto ? 'aprovado' : 'pendente', days });
}

async function handleRespondLeave(request, env, me, leaveId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode aprovar ou rejeitar pedidos.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const status = ['pendente', 'aprovado', 'rejeitado'].includes(body.status) ? body.status : 'aprovado';
  const lv = await env.DB.prepare('SELECT * FROM leaves WHERE id = ?').bind(leaveId).first();
  if (!lv) return json({ error: 'Pedido não encontrado.' }, { status: 404 });
  if (status === 'pendente') {
    await env.DB.prepare('UPDATE leaves SET status = ?, responded_by = NULL, responded_at = NULL WHERE id = ?').bind(status, leaveId).run();
  } else {
    await env.DB.prepare('UPDATE leaves SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?')
      .bind(status, me.id, new Date().toISOString(), leaveId).run();
  }
  return json({ ok: true });
}

async function handleCancelLeave(request, env, me, leaveId) {
  const lv = await env.DB.prepare('SELECT * FROM leaves WHERE id = ?').bind(leaveId).first();
  if (!lv) return json({ error: 'Pedido não encontrado.' }, { status: 404 });
  const today = new Date().toISOString().slice(0, 10);
  const isOwner = lv.employee_id === me.id;
  const canCancel = me.role === 'gestor' || (isOwner && (lv.status === 'pendente' || lv.start_date >= today));
  if (!canCancel) return json({ error: 'Não podes cancelar esta ausência.' }, { status: 403 });
  await env.DB.prepare('DELETE FROM leaves WHERE id = ?').bind(leaveId).run();
  return json({ ok: true });
}

async function handleCreateEmployee(request, env, me) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode gerir colaboradores.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!name || !username || !password) return json({ error: 'Preenche nome, utilizador e palavra-passe.' }, { status: 400 });

  const clash = await env.DB.prepare('SELECT id FROM employees WHERE username = ?').bind(username).first();
  if (clash) return json({ error: 'Já existe um colaborador com esse utilizador.' }, { status: 409 });

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const id = uid('e');
  await env.DB.prepare(
    `INSERT INTO employees (id, name, start_date, username, password_hash, password_salt, role, vacation_days_total, sick_days_total, job_title, contract_type, contract_end, email, phone, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, name, body.startDate || new Date().toISOString().slice(0, 10), username, hash, salt,
    body.role === 'gestor' ? 'gestor' : 'colaborador',
    Math.max(0, parseInt(body.vacationDaysTotal, 10) || 22),
    Math.max(0, parseInt(body.sickDaysTotal, 10) || 3),
    (body.jobTitle || '').trim() || null,
    normalizeContractType(body.contractType),
    body.contractEnd || null,
    (body.email || '').trim() || null,
    (body.phone || '').trim() || null,
    JSON.stringify(normalizeTags(body.tags))
  ).run();
  return json({ ok: true, id });
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const v = String(t || '').trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out.slice(0, 20);
}

async function handleUpdateEmployee(request, env, me, empId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode gerir colaboradores.' }, { status: 403 });
  const target = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(empId).first();
  if (!target) return json({ error: 'Colaborador não encontrado.' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const username = (body.username || '').trim();
  if (!name || !username) return json({ error: 'Preenche nome e utilizador.' }, { status: 400 });

  const clash = await env.DB.prepare('SELECT id FROM employees WHERE username = ? AND id != ?').bind(username, empId).first();
  if (clash) return json({ error: 'Já existe um colaborador com esse utilizador.' }, { status: 409 });

  let passwordHash = target.password_hash, passwordSalt = target.password_salt;
  if (body.password) {
    passwordSalt = randomHex(16);
    passwordHash = await hashPassword(body.password, passwordSalt);
  }

  await env.DB.prepare(
    `UPDATE employees SET name=?, start_date=?, username=?, password_hash=?, password_salt=?, role=?, vacation_days_total=?, sick_days_total=?, job_title=?, contract_type=?, contract_end=?, email=?, phone=?, tags=? WHERE id=?`
  ).bind(
    name, body.startDate || target.start_date, username, passwordHash, passwordSalt,
    body.role === 'gestor' ? 'gestor' : 'colaborador',
    Math.max(0, parseInt(body.vacationDaysTotal, 10) || 0),
    Math.max(0, parseInt(body.sickDaysTotal, 10) || 0),
    (body.jobTitle || '').trim() || null,
    normalizeContractType(body.contractType),
    body.contractEnd || null,
    (body.email || '').trim() || null,
    (body.phone || '').trim() || null,
    JSON.stringify(normalizeTags(body.tags)),
    empId
  ).run();
  return json({ ok: true });
}

async function handleDeleteEmployee(request, env, me, empId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode gerir colaboradores.' }, { status: 403 });
  if (empId === me.id) return json({ error: 'Não podes remover a tua própria conta.' }, { status: 400 });
  await env.DB.prepare('DELETE FROM employees WHERE id = ?').bind(empId).run();
  return json({ ok: true });
}

async function handleUpdateContact(request, env, me) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || '').trim() || null;
  const phone = (body.phone || '').trim() || null;
  await env.DB.prepare('UPDATE employees SET email = ?, phone = ? WHERE id = ?').bind(email, phone, me.id).run();
  return json({ ok: true });
}

const MAX_PHOTO_LENGTH = 400000;

async function handleUpdatePhoto(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const photo = body.photo || null;
  if (photo && (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > MAX_PHOTO_LENGTH)) {
    return json({ error: 'Imagem inválida ou demasiado grande.' }, { status: 400 });
  }
  await env.DB.prepare('UPDATE employees SET photo = ? WHERE id = ?').bind(photo, id).run();
  return json({ ok: true });
}

const ACTIVITY_TYPES = ['chamada', 'reuniao', 'email', 'evento', 'nota', 'outro'];
const ACTIVITY_STATUSES = ['concluido', 'agendado', 'pendente'];
const ACTIVITY_IMPACTS = ['positivo', 'neutro', 'atencao'];

async function handleListActivities(request, env, me, empId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode ver o histórico de interações.' }, { status: 403 });
  const emp = await env.DB.prepare('SELECT name FROM employees WHERE id = ?').bind(empId).first();
  if (!emp) return json({ error: 'Colaborador não encontrado.' }, { status: 404 });
  const rows = await env.DB.prepare('SELECT * FROM activities WHERE employee_id = ? ORDER BY created_at DESC').bind(empId).all();
  return json({ activities: rows.results.map((a) => publicActivity(a, emp.name)) });
}

async function handleCreateActivity(request, env, me, empId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode registar interações.' }, { status: 403 });
  const emp = await env.DB.prepare('SELECT name FROM employees WHERE id = ?').bind(empId).first();
  if (!emp) return json({ error: 'Colaborador não encontrado.' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const details = (body.details || '').trim();
  if (!details) return json({ error: 'Descreve o que aconteceu.' }, { status: 400 });
  const id = uid('a');
  const row = {
    id,
    employee_id: empId,
    type: ACTIVITY_TYPES.includes(body.type) ? body.type : 'nota',
    details,
    status: ACTIVITY_STATUSES.includes(body.status) ? body.status : 'concluido',
    impact: ACTIVITY_IMPACTS.includes(body.impact) ? body.impact : null,
    created_by: me.id,
    created_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    `INSERT INTO activities (id, employee_id, type, details, status, impact, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.employee_id, row.type, row.details, row.status, row.impact, row.created_by, row.created_at).run();
  return json({ ok: true, activity: publicActivity(row, emp.name) });
}

async function handleDeleteActivity(request, env, me, activityId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode remover interações.' }, { status: 403 });
  await env.DB.prepare('DELETE FROM activities WHERE id = ?').bind(activityId).run();
  return json({ ok: true });
}

async function handleUpdateNotes(request, env, me, empId) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode editar notas.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const notes = (body.notes || '').trim() || null;
  await env.DB.prepare('UPDATE employees SET notes = ? WHERE id = ?').bind(notes, empId).run();
  return json({ ok: true });
}

async function handleCreateAnnouncement(request, env, me) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode publicar comunicados.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const title = (body.title || '').trim();
  const abody = (body.body || '').trim();
  if (!title || !abody) return json({ error: 'Preenche o título e a mensagem.' }, { status: 400 });
  const id = uid('an');
  await env.DB.prepare('INSERT INTO announcements (id, title, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, title, abody, me.id, new Date().toISOString()).run();
  return json({ ok: true, id });
}

async function handleDeleteAnnouncement(request, env, me, id) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode remover comunicados.' }, { status: 403 });
  await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function handleCreateMessage(request, env, me) {
  const body = await request.json().catch(() => ({}));
  const subject = (body.subject || '').trim();
  const mbody = (body.body || '').trim();
  if (!subject || !mbody) return json({ error: 'Preenche o assunto e a mensagem.' }, { status: 400 });
  const id = uid('m');
  await env.DB.prepare('INSERT INTO messages (id, employee_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, me.id, subject, mbody, 'aberto', new Date().toISOString()).run();
  return json({ ok: true, id });
}

async function handleRespondMessage(request, env, me, id) {
  if (me.role !== 'gestor') return json({ error: 'Só o gestor pode responder.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const response = (body.response || '').trim();
  if (!response) return json({ error: 'Escreve uma resposta.' }, { status: 400 });
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!msg) return json({ error: 'Pedido não encontrado.' }, { status: 404 });
  await env.DB.prepare('UPDATE messages SET status = ?, response = ?, responded_by = ?, responded_at = ? WHERE id = ?')
    .bind('respondido', response, me.id, new Date().toISOString(), id).run();
  return json({ ok: true });
}

async function handleDeleteMessage(request, env, me, id) {
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!msg) return json({ error: 'Pedido não encontrado.' }, { status: 404 });
  const canDelete = me.role === 'gestor' || (msg.employee_id === me.id && msg.status === 'aberto');
  if (!canDelete) return json({ error: 'Não podes remover este pedido.' }, { status: 403 });
  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params.path) ? params.path : [];
  const method = request.method;

  try {
    if (segments[0] === 'login' && method === 'POST') return await handleLogin(request, env);
    if (segments[0] === 'logout' && method === 'POST') return await handleLogout(request, env);

    const me = await currentEmployee(request, env);
    if (!me) return json({ error: 'Sessão inválida ou expirada.' }, { status: 401 });

    if (segments[0] === 'state' && method === 'GET') return await handleState(request, env, me);
    if (segments[0] === 'leaves' && segments.length === 1 && method === 'POST') return await handleCreateLeave(request, env, me);
    if (segments[0] === 'leaves' && segments[2] === 'respond' && method === 'POST') return await handleRespondLeave(request, env, me, segments[1]);
    if (segments[0] === 'leaves' && segments.length === 2 && method === 'DELETE') return await handleCancelLeave(request, env, me, segments[1]);
    if (segments[0] === 'employees' && segments.length === 1 && method === 'POST') return await handleCreateEmployee(request, env, me);
    if (segments[0] === 'employees' && segments.length === 2 && method === 'PUT') return await handleUpdateEmployee(request, env, me, segments[1]);
    if (segments[0] === 'employees' && segments.length === 2 && method === 'DELETE') return await handleDeleteEmployee(request, env, me, segments[1]);
    if (segments[0] === 'me' && segments[1] === 'contact' && method === 'PUT') return await handleUpdateContact(request, env, me);
    if (segments[0] === 'me' && segments[1] === 'photo' && method === 'PUT') return await handleUpdatePhoto(request, env, me.id);
    if (segments[0] === 'employees' && segments[2] === 'photo' && method === 'PUT') {
      if (me.role !== 'gestor') return json({ error: 'Só o gestor pode alterar a foto de outro colaborador.' }, { status: 403 });
      return await handleUpdatePhoto(request, env, segments[1]);
    }
    if (segments[0] === 'employees' && segments[2] === 'notes' && method === 'PUT') return await handleUpdateNotes(request, env, me, segments[1]);
    if (segments[0] === 'employees' && segments[2] === 'activities' && segments.length === 3 && method === 'GET') return await handleListActivities(request, env, me, segments[1]);
    if (segments[0] === 'employees' && segments[2] === 'activities' && segments.length === 3 && method === 'POST') return await handleCreateActivity(request, env, me, segments[1]);
    if (segments[0] === 'activities' && segments.length === 2 && method === 'DELETE') return await handleDeleteActivity(request, env, me, segments[1]);
    if (segments[0] === 'announcements' && segments.length === 1 && method === 'POST') return await handleCreateAnnouncement(request, env, me);
    if (segments[0] === 'announcements' && segments.length === 2 && method === 'DELETE') return await handleDeleteAnnouncement(request, env, me, segments[1]);
    if (segments[0] === 'messages' && segments.length === 1 && method === 'POST') return await handleCreateMessage(request, env, me);
    if (segments[0] === 'messages' && segments[2] === 'respond' && method === 'POST') return await handleRespondMessage(request, env, me, segments[1]);
    if (segments[0] === 'messages' && segments.length === 2 && method === 'DELETE') return await handleDeleteMessage(request, env, me, segments[1]);

    return json({ error: 'Rota não encontrada.' }, { status: 404 });
  } catch (err) {
    return json({ error: 'Erro interno: ' + (err && err.message ? err.message : String(err)) }, { status: 500 });
  }
}
