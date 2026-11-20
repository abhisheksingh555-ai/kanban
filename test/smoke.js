process.env.DB_FILE = ':memory:';
const assert = require('assert'), WebSocket = require('ws');
const { server } = require('../server/app');
require('../server/seed').seed();

server.listen(0, async () => {
  const port = server.address().port, base = `http://localhost:${port}`;
  const call = async (tok, method, path, body) => {
    const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (e) => (await call('', 'POST', '/auth/login', { email: e, password: 'password123' })).body.token;
  const [alice, bob, carol, erin] = await Promise.all(['alice@acme.test', 'bob@acme.test', 'carol@acme.test', 'erin@globex.test'].map(login));
  const t = (name, ok) => { assert(ok, name); console.log('  ok -', name); };
  const ws = (tok, tid) => new Promise((res) => {
    const s = new WebSocket(`ws://localhost:${port}/ws?token=${tok}&tenant=${tid}`); const m = [];
    s.on('message', (d) => m.push(JSON.parse(d))); s.on('close', (c) => res({ closed: c, m })); s.on('open', () => setTimeout(() => res({ s, m }), 100));
  });
  try {
    t('unauthenticated -> 401', (await call('x', 'GET', '/tenants/1/boards')).status === 401);
    t('member reads own tenant', (await call(carol, 'GET', '/tenants/1/boards')).status === 200);
    t('member cannot read sibling tenant (404)', (await call(carol, 'GET', '/tenants/2/boards')).status === 404);
    t('other org cannot read tenant (404)', (await call(erin, 'GET', '/tenants/1/boards')).status === 404);
    t('org admin reads every tenant of org', (await call(alice, 'GET', '/tenants/2/boards')).status === 200);
    t('member cannot create board (403)', (await call(carol, 'POST', '/tenants/1/boards', { name: 'x' })).status === 403);
    t('cross-tenant task id is invisible', (await call(carol, 'PATCH', '/tenants/1/tasks/4', { version: 1, title: 'x' })).status === 404);

    const board = (await call(carol, 'GET', '/tenants/1/boards/1')).body;
    const [, c2] = board.columns, a = board.tasks[0], b = board.tasks[1];
    const p1 = await call(carol, 'PATCH', `/tenants/1/tasks/${a.id}`, { version: a.version, title: 'Carol edit' });
    t('edit with fresh version ok', p1.status === 200 && p1.body.version === a.version + 1);
    const p2 = await call(bob, 'PATCH', `/tenants/1/tasks/${a.id}`, { version: a.version, title: 'Bob edit' });
    t('stale edit -> 409 with current copy', p2.status === 409 && p2.body.current.title === 'Carol edit');

    t('ws to foreign tenant rejected (4403)', (await ws(carol, 2)).closed === 4403);
    const w = await ws(carol, 1);
    await call(bob, 'POST', `/tenants/1/tasks/${a.id}/move`, { columnId: c2.id, beforeId: null });
    await new Promise((r) => setTimeout(r, 150));
    t('ws receives tenant events + presence', w.m.some((e) => e.type === 'task.moved') && w.m.some((e) => e.type === 'presence'));
    for (let i = 0; i < 60; i++) await call(bob, 'POST', `/tenants/1/tasks/${b.id}/move`, { columnId: c2.id, beforeId: a.id });
    const after = (await call(carol, 'GET', '/tenants/1/boards/1')).body.tasks.filter((x) => x.column_id === c2.id);
    t('order stays correct after repeated inserts at same slot', after.length === 2 && after[0].id === b.id && after[1].id === a.id);
    w.s.close();
    console.log('All checks passed'); process.exit(0);
  } catch (e) { console.error('FAILED', e.message); process.exit(1); }
});
