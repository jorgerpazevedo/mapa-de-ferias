import {
  json, parseCookies, sessionCookie, clearSessionCookie, createSession, currentEmployee,
  hashPassword, verifyPassword, randomHex, publicEmployee, publicLeave,
  businessDays, calendarDays, rangesOverlap, uid,
} from '../_lib.js';

function thisYear() {
  return new Date().getFullYear();
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

async function handleState(request, env, me) {
  if (me.role === 'gestor') {
    const empRows = await env.DB.prepare('SELECT * FROM employees ORDER BY name').all();
    const leaveRows = await env.DB.prepare('SELECT * FROM leaves ORDER BY start_date').all();
    const nameById = {};
    empRows.results.forEach((e) => { nameById[e.id] = e.name; });
    return json({
      role: 'gestor',
      me: { ...publicEmployee(me), balances: await computeBalances(env.DB, me.id) },
      employees: await Promise.all(empRows.results.map(async (e) => ({
        ...publicEmployee(e),
        balances: await computeBalances(env.DB, e.id),
      }))),
      leaves: leaveRows.results.map((l) => publicLeave(l, nameById[l.employee_id])),
    });
  }
  const leaveRows = await env.DB.prepare('SELECT * FROM leaves WHERE employee_id = ? ORDER BY start_date').bind(me.id).all();
  return json({
    role: 'colaborador',
    me: { ...publicEmployee(me), balances: await computeBalances(env.DB, me.id) },
    leaves: leaveRows.results.map((l) => publicLeave(l, me.name)),
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
  const status = body.status === 'rejeitado' ? 'rejeitado' : 'aprovado';
  const lv = await env.DB.prepare('SELECT * FROM leaves WHERE id = ?').bind(leaveId).first();
  if (!lv) return json({ error: 'Pedido não encontrado.' }, { status: 404 });
  await env.DB.prepare('UPDATE leaves SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?')
    .bind(status, me.id, new Date().toISOString(), leaveId).run();
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
    `INSERT INTO employees (id, name, start_date, contact, username, password_hash, password_salt, role, vacation_days_total, sick_days_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, name, body.startDate || new Date().toISOString().slice(0, 10), body.contact || '', username, hash, salt,
    body.role === 'gestor' ? 'gestor' : 'colaborador',
    Math.max(0, parseInt(body.vacationDaysTotal, 10) || 22),
    Math.max(0, parseInt(body.sickDaysTotal, 10) || 3)
  ).run();
  return json({ ok: true, id });
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
    `UPDATE employees SET name=?, start_date=?, contact=?, username=?, password_hash=?, password_salt=?, role=?, vacation_days_total=?, sick_days_total=? WHERE id=?`
  ).bind(
    name, body.startDate || target.start_date, body.contact || '', username, passwordHash, passwordSalt,
    body.role === 'gestor' ? 'gestor' : 'colaborador',
    Math.max(0, parseInt(body.vacationDaysTotal, 10) || 0),
    Math.max(0, parseInt(body.sickDaysTotal, 10) || 0),
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
  const contact = (body.contact || '').trim();
  await env.DB.prepare('UPDATE employees SET contact = ? WHERE id = ?').bind(contact, me.id).run();
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

    return json({ error: 'Rota não encontrada.' }, { status: 404 });
  } catch (err) {
    return json({ error: 'Erro interno: ' + (err && err.message ? err.message : String(err)) }, { status: 500 });
  }
}
