# Real-Time Collaborative Kanban (multi-organization, multi-tenant)

Node.js + Express + `ws` + SQLite (better-sqlite3) backend, dependency-free vanilla JS frontend.

## Run
```bash
npm install
npm run seed     # demo data (password for all users: password123)
npm start        # http://localhost:3000
npm test         # isolation / RBAC / concurrency / websocket smoke tests
```
Demo users: `alice@acme.test` (org admin of Acme), `bob@acme.test` (tenant admin, New York), `carol@acme.test` (member, New York),
`dave@acme.test` (member, London), `erin@globex.test` (org admin of Globex).
Open two browsers as bob and carol on "New York" to watch live sync, presence and drag-and-drop; dave and erin must never see New York data.
Env: `PORT`, `JWT_SECRET` (set it in production), `DB_FILE`.

## Layout
```
server/db.js        schema + connection          server/realtime.js  tenant-scoped WS rooms
server/app.js       REST API, RBAC, concurrency  server/seed.js      demo data
public/             UI (index.html, app.js, style.css)
docs/API.md  docs/ER.md   test/smoke.js
```

## Tenancy model
`Organization -> Tenants (branches) -> Boards -> Columns -> Tasks`.
Users join through `memberships`: an **org_admin** row (tenant_id NULL) covers every tenant of the org; **tenant_admin** / **member** rows are per tenant.
Effective role = highest of the two, resolved on every request (`roleIn`) - no role is cached in the JWT, so revocation is immediate.

Isolation is layered (defence in depth):
1. **Routing/middleware** - every `/tenants/:tid/...` route runs `tenant(minRole)`; non-members get 404 so existence is not leaked.
2. **Query scoping** - every SQL statement on business data includes `tenant_id = ?`; ids from the URL are never trusted alone (a task id from tenant A requested under tenant B is 404).
3. **Schema** - composite FKs `(parent_id, tenant_id)` make cross-tenant references impossible even if code has a bug.
4. **Realtime** - sockets join a per-tenant room only after JWT + membership check; broadcasts are per room.
5. **Org isolation** - an org's admins match only their own `org_id`; another org's users have no membership row at all.

## Concurrency & conflict resolution
* **Edits (title/description)**: optimistic locking. `PATCH` carries `version`; `UPDATE ... WHERE version = ?` is atomic. Mismatch -> **409** with the current copy. The UI shows both versions and lets the user "Keep my changes" (re-submit on top of the new version) or "Use theirs".
* **Moves / drag-drop**: last-writer-wins on *where* a card lives, but the client sends a neighbour anchor (`beforeId`) instead of an index, and the server computes the position at apply time inside a transaction. Two people dragging into the same column both succeed and the order stays consistent; no whole-column rewrite.
* **Ordering**: fractional indexing (`REAL position`, midpoint insert). One row written per move. If the gap becomes < 1e-6 the column is rebalanced and the new positions are broadcast (`reindexed`) - covered by a test.
* **Optimistic UI**: the client applies the change instantly (mirrored placement logic) and reconciles with the server response; on error it reloads the board (rollback). Incoming events only overwrite local state when `version >=` the local one, so out-of-order or echoed events are harmless.
* **Undo/redo**: client-side command stack of inverse API calls (create<->soft-delete/restore, move back to previous neighbour, edit back to previous text). Undo of an edit skips with a message if someone else changed the task meanwhile.
* **Network recovery**: heartbeat + exponential-backoff reconnect; after reconnect the board is re-fetched (REST is the source of truth).
* **Presence**: derived from the live sockets in each tenant room.
* **Activity log**: every mutation is written to `activity_logs` (tenant-scoped); its autoincrement id is the event `seq`.

## Trade-offs / what I would do next
* **SQLite** keeps the project zero-config and serialises writes (better-sqlite3 is synchronous), which makes versioning trivially correct. For production: PostgreSQL with the same schema, and row-level security (`tenant_id = current_setting('app.tenant')`) as an extra net.
* **Scaling WebSockets**: rooms are in-process. For multiple nodes, publish `emit()` events to Redis pub/sub (channel per tenant) and have every node fan out to its local room; presence would move to Redis sets with TTL. `realtime.broadcast` is the single seam to change.
* **Token in WS query string** is simple for browsers; production should use a short-lived one-time WS ticket to keep JWTs out of logs.
* **Column reordering, offline write queue, and CRDT text merge** are not implemented: concurrent description edits are resolved by an explicit user choice (409 dialog), not merged automatically.
* **Soft delete** is used for tasks only (enables undo); deleting boards/columns/tenants/orgs is a hard cascade.
* Rate limiting, password reset and refresh tokens are out of scope.
