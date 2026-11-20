const path = require('path'), http = require('http');
const express = require('express'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const db = require('./db'), rt = require('./realtime');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RANK = { member: 1, tenant_admin: 2, org_admin: 3 };
const GAP = 1024;

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const h = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
const q = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const str = (v, max, field) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${field} is required (max ${max} chars)`);
  return v.trim();
};

// ---------- auth & RBAC ----------
const verify = (t) => { try { return jwt.verify(t, SECRET); } catch { return null; } };
const session = (u) => ({ token: jwt.sign({ id: u.id, name: u.name, email: u.email }, SECRET, { expiresIn: '12h' }), user: { id: u.id, name: u.name, email: u.email } });

// Effective role of a user in a tenant: tenant-level membership OR org-level org_admin of the owning org.
function roleIn(userId, tenantId) {
  const t = q('SELECT org_id FROM tenants WHERE id=?', tenantId);
  if (!t) return null;
  const rows = qa('SELECT role FROM memberships WHERE user_id=? AND org_id=? AND (tenant_id IS NULL OR tenant_id=?)', userId, t.org_id, tenantId);
  return rows.map((r) => r.role).sort((a, b) => RANK[b] - RANK[a])[0] || null;
}
const isOrgAdmin = (uid, oid) => !!q('SELECT 1 FROM memberships WHERE user_id=? AND org_id=? AND tenant_id IS NULL', uid, oid);

const auth = (req, res, next) => {
  const p = verify((req.headers.authorization || '').slice(7));
  if (!p) return res.status(401).json({ error: 'Unauthorized' });
  req.user = p; next();
};
// Non-members get 404 (not 403) so tenant existence is not leaked.
const tenant = (min = 'member') => (req, res, next) => {
  const tid = Number(req.params.tid), role = roleIn(req.user.id, tid);
  if (!role) return res.status(404).json({ error: 'Not found' });
  if (RANK[role] < RANK[min]) return res.status(403).json({ error: `Requires ${min} role` });
  req.tid = tid; req.role = role; next();
};
const orgAdmin = (req, res, next) => {
  const oid = Number(req.params.oid);
  if (!isOrgAdmin(req.user.id, oid)) return res.status(404).json({ error: 'Not found' });
  req.oid = oid; next();
};

// Persist to the activity log and fan out to the tenant's WebSocket room. The log id is a monotonic seq.
function emit(req, type, entity, id, data, details) {
  const info = run('INSERT INTO activity_logs(tenant_id,user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?,?)',
    req.tid, req.user.id, type, entity, id, JSON.stringify(details || {}));
  rt.broadcast(req.tid, { type, seq: Number(info.lastInsertRowid), by: { id: req.user.id, name: req.user.name }, data });
}

// ---------- auth routes ----------
app.post('/api/auth/register', h((req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !name || !password || password.length < 6) throw new HttpError(400, 'email, name and password (min 6 chars) are required');
  if (q('SELECT 1 FROM users WHERE email=?', email.toLowerCase())) throw new HttpError(409, 'Email already registered');
  const r = run('INSERT INTO users(email,name,password_hash) VALUES(?,?,?)', email.toLowerCase(), name, bcrypt.hashSync(password, 10));
  res.status(201).json(session({ id: Number(r.lastInsertRowid), email: email.toLowerCase(), name }));
}));
app.post('/api/auth/login', h((req, res) => {
  const { email, password } = req.body || {};
  const u = q('SELECT * FROM users WHERE email=?', String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) throw new HttpError(401, 'Invalid email or password');
  res.json(session(u));
}));
app.get('/api/me', auth, h((req, res) => {
  const rows = qa('SELECT m.role,m.org_id,m.tenant_id,o.name org_name FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=?', req.user.id);
  const orgs = new Map();
  for (const m of rows) {
    if (!orgs.has(m.org_id)) orgs.set(m.org_id, { id: m.org_id, name: m.org_name, role: null, tenants: [] });
    const o = orgs.get(m.org_id);
    if (m.role === 'org_admin') {
      o.role = 'org_admin';
      o.tenants = qa('SELECT id,name FROM tenants WHERE org_id=?', m.org_id).map((t) => ({ ...t, role: 'org_admin' }));
    } else if (o.role !== 'org_admin') {
      o.role = o.role || m.role;
      o.tenants.push({ ...q('SELECT id,name FROM tenants WHERE id=?', m.tenant_id), role: m.role });
    }
  }
  res.json({ user: req.user, orgs: [...orgs.values()] });
}));

// ---------- organizations & tenants ----------
app.post('/api/orgs', auth, h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  const id = db.transaction(() => {
    const o = Number(run('INSERT INTO organizations(name) VALUES(?)', name).lastInsertRowid);
    run("INSERT INTO memberships(user_id,org_id,tenant_id,role) VALUES(?,?,NULL,'org_admin')", req.user.id, o);
    return o;
  })();
  res.status(201).json({ id, name });
}));
app.patch('/api/orgs/:oid', auth, orgAdmin, h((req, res) => {
  run('UPDATE organizations SET name=? WHERE id=?', str(req.body.name, 100, 'name'), req.oid);
  res.json(q('SELECT * FROM organizations WHERE id=?', req.oid));
}));
app.delete('/api/orgs/:oid', auth, orgAdmin, h((req, res) => { run('DELETE FROM organizations WHERE id=?', req.oid); res.status(204).end(); }));
app.post('/api/orgs/:oid/members', auth, orgAdmin, h((req, res) => {  // promote a user to org admin
  const u = q('SELECT id FROM users WHERE email=?', String(req.body.email || '').toLowerCase());
  if (!u) throw new HttpError(404, 'No user with that email');
  run("INSERT OR IGNORE INTO memberships(user_id,org_id,tenant_id,role) VALUES(?,?,NULL,'org_admin')", u.id, req.oid);
  res.status(201).json({ ok: true });
}));
app.get('/api/orgs/:oid/tenants', auth, orgAdmin, h((req, res) => res.json(qa('SELECT id,name FROM tenants WHERE org_id=?', req.oid))));
app.post('/api/orgs/:oid/tenants', auth, orgAdmin, h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  try {
    const id = Number(run('INSERT INTO tenants(org_id,name) VALUES(?,?)', req.oid, name).lastInsertRowid);
    res.status(201).json({ id, name, org_id: req.oid });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Tenant name already exists in this organization'); throw e; }
}));
app.patch('/api/tenants/:tid', auth, tenant('org_admin'), h((req, res) => {
  run('UPDATE tenants SET name=? WHERE id=?', str(req.body.name, 100, 'name'), req.tid);
  res.json(q('SELECT * FROM tenants WHERE id=?', req.tid));
}));
app.delete('/api/tenants/:tid', auth, tenant('org_admin'), h((req, res) => { run('DELETE FROM tenants WHERE id=?', req.tid); res.status(204).end(); }));

const T = '/api/tenants/:tid';
app.get(`${T}/members`, auth, tenant(), h((req, res) => res.json(qa(
  `SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id
   WHERE m.tenant_id=? OR (m.tenant_id IS NULL AND m.org_id=(SELECT org_id FROM tenants WHERE id=?))`, req.tid, req.tid))));
app.post(`${T}/members`, auth, tenant('tenant_admin'), h((req, res) => {
  const role = req.body.role || 'member';
  if (!['member', 'tenant_admin'].includes(role)) throw new HttpError(400, 'role must be member or tenant_admin');
  const u = q('SELECT id FROM users WHERE email=?', String(req.body.email || '').toLowerCase());
  if (!u) throw new HttpError(404, 'No user with that email');
  const org = q('SELECT org_id FROM tenants WHERE id=?', req.tid).org_id;
  run(`INSERT INTO memberships(user_id,org_id,tenant_id,role) VALUES(?,?,?,?)
       ON CONFLICT(user_id,org_id,tenant_id) DO UPDATE SET role=excluded.role`, u.id, org, req.tid, role);
  emit(req, 'member.added', 'member', u.id, { userId: u.id, role }, { role });
  res.status(201).json({ ok: true });
}));

// ---------- boards & columns ----------
app.get(`${T}/boards`, auth, tenant(), h((req, res) => res.json(qa('SELECT id,name FROM boards WHERE tenant_id=? ORDER BY id', req.tid))));
app.post(`${T}/boards`, auth, tenant('tenant_admin'), h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  const board = db.transaction(() => {
    const id = Number(run('INSERT INTO boards(tenant_id,name) VALUES(?,?)', req.tid, name).lastInsertRowid);
    ['To do', 'In progress', 'Done'].forEach((c, i) => run('INSERT INTO columns(tenant_id,board_id,name,position) VALUES(?,?,?,?)', req.tid, id, c, (i + 1) * GAP));
    return { id, name };
  })();
  emit(req, 'board.created', 'board', board.id, board, { name });
  res.status(201).json(board);
}));
app.get(`${T}/boards/:bid`, auth, tenant(), h((req, res) => {
  const board = q('SELECT id,name FROM boards WHERE id=? AND tenant_id=?', req.params.bid, req.tid);
  if (!board) throw new HttpError(404, 'Board not found');
  res.json({
    board,
    columns: qa('SELECT * FROM columns WHERE board_id=? AND tenant_id=? ORDER BY position', board.id, req.tid),
    tasks: qa(`SELECT t.* FROM tasks t JOIN columns c ON c.id=t.column_id AND c.tenant_id=t.tenant_id
               WHERE c.board_id=? AND t.tenant_id=? AND t.deleted_at IS NULL ORDER BY t.position`, board.id, req.tid),
  });
}));
app.patch(`${T}/boards/:bid`, auth, tenant('tenant_admin'), h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  if (!run('UPDATE boards SET name=? WHERE id=? AND tenant_id=?', name, req.params.bid, req.tid).changes) throw new HttpError(404, 'Board not found');
  emit(req, 'board.updated', 'board', Number(req.params.bid), { id: Number(req.params.bid), name }, { name });
  res.json({ id: Number(req.params.bid), name });
}));
app.delete(`${T}/boards/:bid`, auth, tenant('tenant_admin'), h((req, res) => {
  if (!run('DELETE FROM boards WHERE id=? AND tenant_id=?', req.params.bid, req.tid).changes) throw new HttpError(404, 'Board not found');
  emit(req, 'board.deleted', 'board', Number(req.params.bid), { id: Number(req.params.bid) });
  res.status(204).end();
}));
app.post(`${T}/boards/:bid/columns`, auth, tenant('tenant_admin'), h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  if (!q('SELECT 1 FROM boards WHERE id=? AND tenant_id=?', req.params.bid, req.tid)) throw new HttpError(404, 'Board not found');
  const pos = (q('SELECT MAX(position) p FROM columns WHERE board_id=? AND tenant_id=?', req.params.bid, req.tid).p || 0) + GAP;
  const id = Number(run('INSERT INTO columns(tenant_id,board_id,name,position) VALUES(?,?,?,?)', req.tid, req.params.bid, name, pos).lastInsertRowid);
  const col = q('SELECT * FROM columns WHERE id=?', id);
  emit(req, 'column.created', 'column', id, { column: col }, { name });
  res.status(201).json(col);
}));
app.patch(`${T}/columns/:cid`, auth, tenant('tenant_admin'), h((req, res) => {
  const name = str(req.body.name, 100, 'name');
  if (!run('UPDATE columns SET name=? WHERE id=? AND tenant_id=?', name, req.params.cid, req.tid).changes) throw new HttpError(404, 'Column not found');
  const col = q('SELECT * FROM columns WHERE id=?', req.params.cid);
  emit(req, 'column.updated', 'column', col.id, { column: col }, { name });
  res.json(col);
}));
app.delete(`${T}/columns/:cid`, auth, tenant('tenant_admin'), h((req, res) => {
  if (!run('DELETE FROM columns WHERE id=? AND tenant_id=?', req.params.cid, req.tid).changes) throw new HttpError(404, 'Column not found');
  emit(req, 'column.deleted', 'column', Number(req.params.cid), { id: Number(req.params.cid) });
  res.status(204).end();
}));

// ---------- tasks ----------
const getTask = (tid, id) => q('SELECT * FROM tasks WHERE id=? AND tenant_id=?', id, tid);

// Fractional ordering: new position = midpoint of neighbours. The server computes it from the
// anchor (beforeId) at apply-time, so two users dragging concurrently never overwrite each other's order.
function placeAt(tid, colId, beforeId, excludeId) {
  const rows = () => qa('SELECT id,position FROM tasks WHERE tenant_id=? AND column_id=? AND deleted_at IS NULL AND id!=? ORDER BY position', tid, colId, excludeId || 0);
  let reindexed = null, list = rows();
  const idxOf = () => { const i = list.findIndex((r) => r.id === Number(beforeId)); return i < 0 ? list.length : i; };
  let i = idxOf(), prev = list[i - 1]?.position ?? 0, next = list[i]?.position;
  if (next !== undefined && next - prev < 1e-6) {           // precision exhausted -> rebalance column
    list.forEach((r, n) => run('UPDATE tasks SET position=? WHERE id=? AND tenant_id=?', (n + 1) * GAP, r.id, tid));
    list = rows(); reindexed = list.map((r) => ({ id: r.id, position: r.position }));
    i = idxOf(); prev = list[i - 1]?.position ?? 0; next = list[i]?.position;
  }
  return { position: next === undefined ? prev + GAP : (prev + next) / 2, reindexed };
}

app.post(`${T}/columns/:cid/tasks`, auth, tenant(), h((req, res) => {
  const title = str(req.body.title, 200, 'title');
  const col = q('SELECT id FROM columns WHERE id=? AND tenant_id=?', req.params.cid, req.tid);
  if (!col) throw new HttpError(404, 'Column not found');
  const { position } = placeAt(req.tid, col.id, null, 0);
  const id = Number(run('INSERT INTO tasks(tenant_id,column_id,title,description,position,created_by,updated_by) VALUES(?,?,?,?,?,?,?)',
    req.tid, col.id, title, String(req.body.description || '').slice(0, 5000), position, req.user.id, req.user.id).lastInsertRowid);
  const task = getTask(req.tid, id);
  emit(req, 'task.created', 'task', id, { task }, { title });
  res.status(201).json(task);
}));

// Edits use optimistic locking: the client must send the version it last saw.
app.patch(`${T}/tasks/:id`, auth, tenant(), h((req, res) => {
  const cur = getTask(req.tid, req.params.id);
  if (!cur || cur.deleted_at) throw new HttpError(404, 'Task not found');
  const { version } = req.body;
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  const title = req.body.title === undefined ? cur.title : str(req.body.title, 200, 'title');
  const description = req.body.description === undefined ? cur.description : String(req.body.description).slice(0, 5000);
  const r = run(`UPDATE tasks SET title=?,description=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP
                 WHERE id=? AND tenant_id=? AND version=?`, title, description, req.user.id, cur.id, req.tid, version);
  if (!r.changes) throw new HttpError(409, 'Version conflict: task was changed by someone else', { current: getTask(req.tid, cur.id) });
  const task = getTask(req.tid, cur.id);
  emit(req, 'task.updated', 'task', cur.id, { task }, { from: { title: cur.title, description: cur.description }, version: task.version });
  res.json(task);
}));

// Moves are last-writer-wins on (column, order) but anchored to a neighbour id, so concurrent drags compose.
app.post(`${T}/tasks/:id/move`, auth, tenant(), h((req, res) => {
  const { columnId, beforeId = null } = req.body;
  const out = db.transaction(() => {
    const cur = getTask(req.tid, req.params.id);
    if (!cur || cur.deleted_at) throw new HttpError(404, 'Task not found');
    if (!q('SELECT 1 FROM columns WHERE id=? AND tenant_id=?', columnId, req.tid)) throw new HttpError(404, 'Column not found');
    const { position, reindexed } = placeAt(req.tid, columnId, beforeId, cur.id);
    run(`UPDATE tasks SET column_id=?,position=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?`,
      columnId, position, req.user.id, cur.id, req.tid);
    return { cur, task: getTask(req.tid, cur.id), reindexed };
  })();
  emit(req, 'task.moved', 'task', out.cur.id, { task: out.task, reindexed: out.reindexed }, { from: out.cur.column_id, to: columnId, title: out.cur.title });
  res.json(out.task);
}));
app.delete(`${T}/tasks/:id`, auth, tenant(), h((req, res) => {
  const cur = getTask(req.tid, req.params.id);
  if (!cur || cur.deleted_at) throw new HttpError(404, 'Task not found');
  run('UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_by=? WHERE id=? AND tenant_id=?', req.user.id, cur.id, req.tid);
  const task = getTask(req.tid, cur.id);
  emit(req, 'task.deleted', 'task', cur.id, { task }, { title: cur.title });
  res.json(task);
}));
app.post(`${T}/tasks/:id/restore`, auth, tenant(), h((req, res) => {
  const cur = getTask(req.tid, req.params.id);
  if (!cur) throw new HttpError(404, 'Task not found');
  run('UPDATE tasks SET deleted_at=NULL,version=version+1,updated_by=? WHERE id=? AND tenant_id=?', req.user.id, cur.id, req.tid);
  const task = getTask(req.tid, cur.id);
  emit(req, 'task.restored', 'task', cur.id, { task }, { title: cur.title });
  res.json(task);
}));

app.get(`${T}/activity`, auth, tenant(), h((req, res) => res.json(qa(
  `SELECT a.id,a.action,a.entity,a.entity_id,a.details,a.created_at,u.name user_name FROM activity_logs a
   LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? AND a.id>? ORDER BY a.id DESC LIMIT ?`,
  req.tid, Number(req.query.since) || 0, Math.min(Number(req.query.limit) || 50, 200)))));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err); res.status(500).json({ error: 'Internal error' });
});

const server = http.createServer(app);
rt.attach(server, (token, tid) => { const p = verify(token); return p && roleIn(p.id, tid) ? p : null; });
module.exports = { app, server };
