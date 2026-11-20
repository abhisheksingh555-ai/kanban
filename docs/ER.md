# Database schema (ER diagram)

```mermaid
erDiagram
  organizations ||--o{ tenants : "has"
  organizations ||--o{ memberships : "scopes"
  tenants ||--o{ memberships : "optional scope"
  users ||--o{ memberships : "has"
  tenants ||--o{ boards : "owns"
  boards ||--o{ columns : "has"
  columns ||--o{ tasks : "has"
  tenants ||--o{ activity_logs : "records"
  users ||--o{ activity_logs : "performs"
  organizations { int id PK  text name }
  tenants { int id PK  int org_id FK  text name }
  users { int id PK  text email UK  text name  text password_hash }
  memberships { int id PK  int user_id FK  int org_id FK  int tenant_id FK "NULL for org_admin"  text role }
  boards { int id PK  int tenant_id FK  text name }
  columns { int id PK  int tenant_id FK  int board_id FK  text name  real position }
  tasks { int id PK  int tenant_id FK  int column_id FK  text title  text description  real position  int version  int created_by  int updated_by  text deleted_at }
  activity_logs { int id PK "= event seq"  int tenant_id FK  int user_id FK  text action  text entity  int entity_id  text details }
```

Isolation is enforced in the schema, not only in code:

* `boards`, `columns`, `tasks`, `activity_logs` all carry `tenant_id`.
* Children reference parents by a **composite FK** `(parent_id, tenant_id)` -> `parent(id, tenant_id)`, so a task can never point to a column of another tenant.
* `memberships (tenant_id, org_id)` -> `tenants (id, org_id)` guarantees a tenant membership belongs to the tenant's own organization.
* `CHECK ((role='org_admin') = (tenant_id IS NULL))` keeps org-level and tenant-level roles unambiguous.
* Indexes are tenant-leading: `(tenant_id, column_id, position)`, `(tenant_id, id)`.
