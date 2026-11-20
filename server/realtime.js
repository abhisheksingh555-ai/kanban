// Scoped WebSocket channels: one "room" per tenant. A socket is admitted to a room only
// after the JWT is verified AND the user's membership for that tenant is confirmed, so a
// client can never subscribe to a tenant it does not belong to.
const { WebSocketServer } = require('ws');
const rooms = new Map(); // tenantId -> Set<ws>

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const presence = (tid) => {
  const m = new Map();
  for (const c of rooms.get(tid) || []) m.set(c.user.id, { id: c.user.id, name: c.user.name });
  return [...m.values()];
};
function broadcast(tid, msg) { for (const c of rooms.get(tid) || []) send(c, msg); }

function attach(server, authorize) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const u = new URL(req.url, 'http://x');
    const tid = Number(u.searchParams.get('tenant'));
    const user = authorize(u.searchParams.get('token'), tid);
    if (!user) return ws.close(4403, 'forbidden');
    ws.user = user; ws.tid = tid; ws.alive = true;
    if (!rooms.has(tid)) rooms.set(tid, new Set());
    rooms.get(tid).add(ws);
    broadcast(tid, { type: 'presence', data: { users: presence(tid) } });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => {
      const r = rooms.get(tid); r.delete(ws);
      if (!r.size) rooms.delete(tid); else broadcast(tid, { type: 'presence', data: { users: presence(tid) } });
    });
  });
  setInterval(() => wss.clients.forEach((c) => {
    if (!c.alive) return c.terminate(); c.alive = false; c.ping();
  }), 30000).unref();
}
module.exports = { attach, broadcast };
