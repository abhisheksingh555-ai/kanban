# API & WebSocket reference

All routes are JSON. Except `/api/auth/*`, send `Authorization: Bearer <jwt>`.
Errors: `{ "error": "message" }` (409 also returns `current`, the server's copy).
A user who is not a member of a tenant always gets **404** (existence is not leaked); a member with too low a role gets **403**.

Roles: `member` < `tenant_admin` < `org_admin` (org_admin is implicitly admin of every tenant in its organization).

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /api/auth/register | email, name, password(>=6) | returns `{token,user}` |
| POST | /api/auth/login | email, password | returns `{token,user}` |
| GET | /api/me | | orgs -> tenants the user can access, with role |

## Organizations & tenants
| Method | Path | Min role | Notes |
|---|---|---|---|
| POST | /api/orgs | any user | creator becomes org_admin |
| PATCH / DELETE | /api/orgs/:oid | org_admin | |
| POST | /api/orgs/:oid/members | org_admin | `{email}` promotes to org_admin |
| GET / POST | /api/orgs/:oid/tenants | org_admin | `{name}` |
| PATCH / DELETE | /api/tenants/:tid | org_admin | |
| GET | /api/tenants/:tid/members | member | |
| POST | /api/tenants/:tid/members | tenant_admin | `{email, role: member|tenant_admin}` |

## Boards, columns (prefix `/api/tenants/:tid`)
| Method | Path | Min role |
|---|---|---|
| GET | /boards | member |
| POST | /boards `{name}` (creates To do / In progress / Done) | tenant_admin |
| GET | /boards/:bid -> `{board, columns, tasks}` | member |
| PATCH / DELETE | /boards/:bid | tenant_admin |
| POST | /boards/:bid/columns `{name}` | tenant_admin |
| PATCH / DELETE | /columns/:cid | tenant_admin |

## Tasks (prefix `/api/tenants/:tid`, min role `member`)
| Method | Path | Body |
|---|---|---|
| POST | /columns/:cid/tasks | `{title, description?}` -> appended at the end |
| PATCH | /tasks/:id | `{version, title?, description?}`; **409** if `version` is stale |
| POST | /tasks/:id/move | `{columnId, beforeId|null}` - place before task `beforeId` (null = end) |
| DELETE | /tasks/:id | soft delete |
| POST | /tasks/:id/restore | undo of delete/create |
| GET | /activity?since=&limit= | newest first |

## WebSocket
`ws://host/ws?token=<jwt>&tenant=<tenantId>`

* The server verifies the JWT and the membership **before** admitting the socket. Failure -> close code `4403`.
* One room per tenant; a socket only ever receives events of its tenant.
* Server -> client only. Writes go through REST (so authorization, validation and versioning have a single code path).
* Message shape: `{ type, seq, by:{id,name}, data }`. `seq` is the activity-log id (monotonic).

| type | data |
|---|---|
| presence | `{users:[{id,name}]}` (sent on every join/leave) |
| task.created / updated / moved / deleted / restored | `{task, reindexed?}`; `reindexed` = `[{id,position}]` when a column was rebalanced |
| column.created / updated | `{column}` |
| column.deleted, board.created / updated / deleted | `{id}` / board |
| member.added | `{userId, role}` |

Heartbeat: server pings every 30 s and terminates dead sockets. On reconnect the client re-fetches the board.
