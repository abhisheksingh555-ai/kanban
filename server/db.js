const Database = require('better-sqlite3');
const db = new Database(process.env.DB_FILE || 'kanban.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Tenant isolation is enforced in the schema: every business row carries tenant_id and
// child rows reference their parent through a COMPOSITE FK (parent_id, tenant_id), so a
// task can never point at a column that belongs to another tenant.
db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, name), UNIQUE(id, org_id));
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL);
-- org_admin rows have tenant_id NULL (apply to every tenant of the org); others are per-tenant.
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL,
  tenant_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('org_admin','tenant_admin','member')),
  CHECK ((role = 'org_admin') = (tenant_id IS NULL)),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants(id, org_id) ON DELETE CASCADE,
  UNIQUE(user_id, org_id, tenant_id));
CREATE UNIQUE INDEX IF NOT EXISTS ux_org_admin ON memberships(user_id, org_id) WHERE tenant_id IS NULL;
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(id, tenant_id));
CREATE TABLE IF NOT EXISTS columns (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, board_id INTEGER NOT NULL,
  name TEXT NOT NULL, position REAL NOT NULL,
  UNIQUE(id, tenant_id),
  FOREIGN KEY (board_id, tenant_id) REFERENCES boards(id, tenant_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ix_columns ON columns(tenant_id, board_id, position);
-- position is a REAL (fractional indexing): moving a task rewrites ONE row, not the whole column.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, column_id INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,             -- optimistic-lock token
  created_by INTEGER REFERENCES users(id), updated_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,                                 -- soft delete => undo/restore
  FOREIGN KEY (column_id, tenant_id) REFERENCES columns(id, tenant_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ix_tasks ON tasks(tenant_id, column_id, position);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY,                          -- monotonically increasing => event sequence
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL,
  entity_id INTEGER, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_activity ON activity_logs(tenant_id, id);
`);
module.exports = db;
