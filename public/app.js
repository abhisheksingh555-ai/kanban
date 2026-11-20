/* Vanilla JS client. State lives in S; render() is cheap so every change simply re-renders. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RANK = { member: 1, tenant_admin: 2, org_admin: 3 };
const S = { token: localStorage.token, me: null, org: null, tenant: null, role: 'member', boards: [], board: null,
  cols: [], tasks: [], presence: [], undo: [], redo: [], ws: null, sel: null, conflict: null, drag: null, dirty: false, retry: 0, wasDown: false };
const base = () => `/tenants/${S.tenant}`;
const canAdmin = () => RANK[S.role] >= 2;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; e.data = j; throw e; }
  return j;
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3000); }

// ---------- boot / auth ----------
async function login() {
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    S.token = localStorage.token = j.token; boot();
  } catch (e) { $('#loginErr').textContent = e.message; }
}
async function boot() {
  if (!S.token) { $('#login').hidden = false; $('#app').hidden = true; return; }
  try { S.me = await api('/me'); } catch { delete localStorage.token; S.token = null; return boot(); }
  $('#login').hidden = true; $('#app').hidden = false;
  S.org = S.me.orgs.find((o) => o.id === +localStorage.org)?.id ?? S.me.orgs[0]?.id;
  await pickOrg(S.org);
}
async function pickOrg(id) {
  S.org = +id; localStorage.org = id;
  const o = S.me.orgs.find((x) => x.id === S.org);
  const t = o?.tenants.find((x) => x.id === +localStorage.tenant) || o?.tenants[0];
  await pickTenant(t?.id);
}
async function pickTenant(id) {
  S.tenant = id ? +id : null; localStorage.tenant = id || ''; S.undo = []; S.redo = []; S.sel = null; S.conflict = null;
  const t = S.me.orgs.find((o) => o.id === S.org)?.tenants.find((x) => x.id === S.tenant);
  S.role = t?.role || 'member';
  S.boards = S.tenant ? await api(base() + '/boards') : [];
  S.board = S.boards.find((b) => b.id === +localStorage.board) || S.boards[0] || null;
  await loadBoard(); connect();
}
async function loadBoard() {
  if (!S.board) { S.cols = []; S.tasks = []; return render(); }
  try { const d = await api(`${base()}/boards/${S.board.id}`); S.cols = d.columns; S.tasks = d.tasks; }
  catch (e) { toast(e.message); }
  render();
}

// ---------- local state helpers ----------
const inCol = (cid, ex) => S.tasks.filter((t) => t.column_id === cid && t.id !== ex).sort((a, b) => a.position - b.position);
function localPos(cid, beforeId, ex) { // mirrors the server's fractional-index placement for optimistic UI
  const l = inCol(cid, ex); let i = l.findIndex((t) => t.id === beforeId); if (i < 0) i = l.length;
  const prev = l[i - 1]?.position ?? 0, next = l[i]?.position;
  return next === undefined ? prev + 1024 : (prev + next) / 2;
}
function applyTask(t, reindexed) {
  (reindexed || []).forEach((r) => { const x = S.tasks.find((y) => y.id === r.id); if (x) x.position = r.position; });
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (t.deleted_at) { if (i >= 0) S.tasks.splice(i, 1); if (S.sel === t.id) S.sel = null; }
  else if (i < 0) S.tasks.push(t);
  else if (t.version >= S.tasks[i].version) S.tasks[i] = t;
}

// ---------- mutations (optimistic, with undo/redo records) ----------
const push = (rec) => { S.undo.push(rec); S.redo = []; };
async function addTask(cid) {
  const title = prompt('Task title'); if (!title) return;
  try { const t = await api(`${base()}/columns/${cid}/tasks`, 'POST', { title }); applyTask(t); render();
    push({ undo: () => delTask(t.id, false), redo: () => restoreTask(t.id, false) }); } catch (e) { toast(e.message); }
}
async function delTask(id, rec = true) {
  const old = S.tasks.find((t) => t.id === id);
  S.tasks = S.tasks.filter((t) => t.id !== id); if (S.sel === id) S.sel = null; render();
  try { await api(`${base()}/tasks/${id}`, 'DELETE'); if (rec && old) push({ undo: () => restoreTask(id, false), redo: () => delTask(id, false) }); }
  catch (e) { toast(e.message); loadBoard(); }
}
async function restoreTask(id, rec = true) {
  try { applyTask(await api(`${base()}/tasks/${id}/restore`, 'POST')); render(); } catch (e) { toast(e.message); }
}
async function moveTask(id, cid, beforeId, rec = true) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  const sib = inCol(t.column_id).find((x) => x.position > t.position);
  const from = { cid: t.column_id, before: sib?.id ?? null };
  t.column_id = cid; t.position = localPos(cid, beforeId, id); render();           // optimistic
  try {
    const r = await api(`${base()}/tasks/${id}/move`, 'POST', { columnId: cid, beforeId });
    applyTask(r); render();
    if (rec) push({ undo: () => moveTask(id, from.cid, from.before, false), redo: () => moveTask(id, cid, beforeId, false) });
  } catch (e) { toast(e.message); loadBoard(); }                                      // roll back to server truth
}
async function saveTask(fields, rec = true) {
  const t = S.tasks.find((x) => x.id === S.sel); if (!t) return;
  const old = { title: t.title, description: t.description };
  try {
    const n = await api(`${base()}/tasks/${t.id}`, 'PATCH', { ...fields, version: t.version });
    S.conflict = null; applyTask(n); render(); toast('Saved');
    if (rec) push({ undo: () => patchLatest(n.id, old), redo: () => patchLatest(n.id, fields) });
  } catch (e) {
    if (e.status === 409) { S.conflict = { mine: fields, theirs: e.data.current }; applyTask(e.data.current); render(); }
    else toast(e.message);
  }
}
async function patchLatest(id, fields) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  try { applyTask(await api(`${base()}/tasks/${id}`, 'PATCH', { ...fields, version: t.version })); render(); }
  catch (e) { toast(e.status === 409 ? 'Someone changed this task — undo skipped' : e.message); }
}
async function step(from, to) {
  const rec = S[from].pop(); if (!rec) return;
  await rec[from === 'undo' ? 'undo' : 'redo'](); S[to].push(rec); render();
}

// ---------- rendering ----------
function render() {
  if (S.drag) { S.dirty = true; return; }
  const o = S.me?.orgs.find((x) => x.id === S.org);
  $('#orgSel').innerHTML = S.me.orgs.map((x) => `<option value="${x.id}" ${x.id === S.org ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#tenSel').innerHTML = (o?.tenants || []).map((x) => `<option value="${x.id}" ${x.id === S.tenant ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#boardSel').innerHTML = S.boards.map((x) => `<option value="${x.id}" ${x.id === S.board?.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('') || '<option>No boards</option>';
  $('#adminBtns').innerHTML = canAdmin() ? '<button data-a="board">+ Board</button> <button data-a="col">+ Column</button> <button data-a="member">+ Member</button>' : '';
  $('#undoBtn').disabled = !S.undo.length; $('#redoBtn').disabled = !S.redo.length;
  $('#presence').innerHTML = S.presence.map((u) => `<span class="av" title="${esc(u.name)}">${esc(u.name[0])}</span>`).join('');
  $('#board').innerHTML = S.board ? S.cols.map((c) => {
    const ts = inCol(c.id);
    return `<section class="col" data-col="${c.id}"><header><h3>${esc(c.name)}</h3><span class="count">${ts.length}</span><span class="spacer"></span>
      ${canAdmin() ? `<button data-a="rename" data-id="${c.id}" title="Rename">✎</button><button data-a="delcol" data-id="${c.id}" title="Delete column">✕</button>` : ''}</header>
      <div class="cards" data-col="${c.id}">${ts.map((t) => `<article class="card ${t.id === S.sel ? 'sel' : ''}" draggable="true" data-id="${t.id}" tabindex="0">${esc(t.title)}</article>`).join('')}</div>
      <button class="add" data-a="add" data-id="${c.id}">+ Add task</button></section>`;
  }).join('') : `<p class="meta">${canAdmin() ? 'No boards yet. Use “+ Board” to create one.' : 'No boards in this tenant yet. Ask a tenant admin to create one.'}</p>`;
  renderPanel();
}
function renderPanel() {
  const p = $('#panel'), t = S.tasks.find((x) => x.id === S.sel);
  p.hidden = !t; if (!t) return;
  const c = S.conflict;
  p.innerHTML = `${c ? `<div class="notice"><b>Someone else edited this task first.</b>
      <div class="meta">Their version:</div><pre>${esc(c.theirs.title)}\n${esc(c.theirs.description)}</pre>
      <div class="row"><button class="primary" id="keepMine">Keep my changes</button><button id="useTheirs">Use theirs</button></div></div>` : ''}
    <input id="pTitle" value="${esc(c ? c.mine.title ?? t.title : t.title)}" aria-label="Title">
    <textarea id="pDesc" aria-label="Description" placeholder="Add details">${esc(c ? c.mine.description ?? t.description : t.description)}</textarea>
    <div class="row"><button class="primary" id="pSave">Save</button><button class="danger" id="pDel">Delete</button><button id="pClose">Close</button></div>
    <div class="meta">Version ${t.version} · updated ${esc(t.updated_at)}</div>`;
}
function setStatus(on) { $('#status').classList.toggle('on', on); $('#status').title = on ? 'Live' : 'Offline – reconnecting'; }

// ---------- realtime ----------
function connect() {
  if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  S.presence = []; S.retry = 0; if (S.tenant) open(S.tenant);
}
function open(tid) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${S.token}&tenant=${tid}`);
  S.ws = ws;
  ws.onopen = () => { setStatus(true); S.retry = 0; if (S.wasDown) { S.wasDown = false; loadBoard(); toast('Back online'); } }; // resync after outage
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = (ev) => { setStatus(false); S.wasDown = true; if (S.tenant !== tid || ev.code === 4403) return; setTimeout(() => S.tenant === tid && open(tid), Math.min(1000 * 2 ** S.retry++, 15000)); };
}
function onEvent(ev) {
  const d = ev.data;
  if (ev.type === 'presence') { S.presence = d.users; return render(); }
  if (ev.type.startsWith('task.')) {
    const own = S.sel && d.task.id === S.sel, t = S.tasks.find((x) => x.id === d.task.id);
    const editing = own && ev.by.id !== S.me.user.id && document.activeElement?.closest('#panel');
    if (editing && t && d.task.version > t.version && !S.conflict) toast(`${ev.by.name} just changed this task`);
    applyTask(d.task, d.reindexed); S.drag ? (S.dirty = true) : (editing ? renderBoardOnly() : render());
  } else if (ev.type.startsWith('column.') || ev.type.startsWith('board.')) {
    if (ev.type.startsWith('board.')) api(base() + '/boards').then((b) => { S.boards = b; if (!b.find((x) => x.id === S.board?.id)) S.board = b[0] || null; loadBoard(); });
    else loadBoard();
  }
  if (!$('#activity').hidden) loadActivity();
}
function renderBoardOnly() { const p = $('#panel').innerHTML; render(); $('#panel').innerHTML = p; } // keep the user's in-progress typing
async function loadActivity() {
  const rows = await api(base() + '/activity?limit=40'), a = $('#activity');
  a.innerHTML = `<h3>Activity</h3><ul>${rows.map((r) => { const d = JSON.parse(r.details || '{}');
    return `<li><b>${esc(r.user_name || 'System')}</b> ${esc(r.action.replace('.', ' '))} ${esc(d.title || d.name || '')}<div class="meta">${esc(r.created_at)}</div></li>`; }).join('')}</ul>`;
}

// ---------- DOM events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, .card'); if (!el) return;
  if (el.classList.contains('card')) { S.sel = +el.dataset.id; S.conflict = null; return render(); }
  const id = +el.dataset.id, a = el.dataset.a;
  try {
    if (a === 'add') addTask(id);
    if (a === 'board') { const name = prompt('Board name'); if (name) { const b = await api(base() + '/boards', 'POST', { name }); localStorage.board = b.id; } }
    if (a === 'col') { const name = prompt('Column name'); if (name) await api(`${base()}/boards/${S.board.id}/columns`, 'POST', { name }); }
    if (a === 'rename') { const name = prompt('New name', S.cols.find((c) => c.id === id).name); if (name) await api(`${base()}/columns/${id}`, 'PATCH', { name }); }
    if (a === 'delcol' && confirm('Delete this column and all its tasks?')) await api(`${base()}/columns/${id}`, 'DELETE');
    if (a === 'member') { const email = prompt('Email of an existing user'); if (email) { const role = confirm('Make them a tenant admin? (Cancel = member)') ? 'tenant_admin' : 'member'; await api(base() + '/members', 'POST', { email, role }); toast('Member added'); } }
  } catch (err) { toast(err.message); }
  switch (el.id) {
    case 'pSave': saveTask({ title: $('#pTitle').value, description: $('#pDesc').value }); break;
    case 'keepMine': saveTask(S.conflict.mine); break;
    case 'useTheirs': S.conflict = null; render(); break;
    case 'pDel': delTask(S.sel); break;
    case 'pClose': S.sel = null; S.conflict = null; render(); break;
    case 'undoBtn': step('undo', 'redo'); break;
    case 'redoBtn': step('redo', 'undo'); break;
    case 'actBtn': $('#activity').hidden = !$('#activity').hidden; if (!$('#activity').hidden) loadActivity(); break;
    case 'logout': delete localStorage.token; location.reload(); break;
    case 'loginBtn': login(); break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'orgSel') pickOrg(e.target.value);
  if (e.target.id === 'tenSel') pickTenant(e.target.value);
  if (e.target.id === 'boardSel') { S.board = S.boards.find((b) => b.id === +e.target.value); localStorage.board = S.board.id; loadBoard(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'password') login();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); step(e.shiftKey ? 'redo' : 'undo', e.shiftKey ? 'undo' : 'redo'); }
});

// Drag & drop: a placeholder shows the drop slot; on drop we send the neighbour id, not an index.
function slot(container, y) {
  return [...container.querySelectorAll('.card:not(.drag)')].find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
}
const board = $('#board');
board.addEventListener('dragstart', (e) => { const c = e.target.closest('.card'); if (!c) return; S.drag = +c.dataset.id; c.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', S.drag); });
board.addEventListener('dragover', (e) => {
  const box = e.target.closest('.cards'); if (!box || !S.drag) return; e.preventDefault();
  let ph = board.querySelector('.ph'); if (!ph) { ph = document.createElement('div'); ph.className = 'ph'; }
  box.insertBefore(ph, slot(box, e.clientY));
});
board.addEventListener('drop', (e) => {
  const box = e.target.closest('.cards'); if (!box || !S.drag) return; e.preventDefault();
  const ph = board.querySelector('.ph'), before = ph?.nextElementSibling?.classList.contains('card') ? +ph.nextElementSibling.dataset.id : null;
  const id = S.drag; S.drag = null; moveTask(id, +box.dataset.col, before === id ? null : before);
});
board.addEventListener('dragend', () => { S.drag = null; if (S.dirty) { S.dirty = false; } render(); });

boot();
