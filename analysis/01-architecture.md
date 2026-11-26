# Architecture

> Scope: `rbac` v6.0.0 (`master` @ `d3eea5d`). This covers all of `src/` (about 1,000 lines of library code and 315 lines of tests).

## 1. What the library is

`rbac` is a small, **hierarchical role-based access control** library for Node.js. It models three things:

| Concept | Class | Identity |
|---|---|---|
| Role | `Role` ([src/Role.js](../src/Role.js)) | `name`, e.g. `admin` |
| Permission | `Permission` ([src/Permission.js](../src/Permission.js)) | `action + delimiter + resource`, e.g. `create_article` |
| Grant (edge) | *no class*: a list of child names stored per role | `role → (role \| permission)` |

A role can be granted permissions **and other roles**. Granted roles pass their permissions up to the parent, so you get a directed graph (a DAG in intent, though cycles are allowed; see the security doc). An authorization check (`can`) is a breadth-first search over that graph.

The library has **no notion of users or subjects**. Callers map a user to a role name themselves. It also has no notion of resource instances or ownership (ABAC). It answers one question: "does role *R* reach permission *(action, resource)*?"

## 2. Module map

```
src/
├── index.js        Public barrel: re-exports RBAC, Base, Role, Permission, Storage, Memory
├── RBAC.js         Facade / service layer: validation, bulk creation, graph traversal, queries
├── Base.js         Abstract entity: (rbac, name) + add()/remove() delegation
├── Role.js         Entity: name validation + convenience methods that delegate to RBAC
├── Permission.js   Entity + value codec: createName/decodeName/isValidName, can()
├── Storage.js      Abstract repository: storage contract + derived helpers (getRole, exists…)
├── Memory.js       Concrete repository: in-process hash map
└── RBAC.test.js    Jest scenario test (Memory storage only)
```

### Dependency graph

```
            index.js
               │
   ┌───────────┼──────────────────────────┐
   ▼           ▼                          ▼
 RBAC ───► Memory ───► Storage ───► Role ───► Permission ───► Base
   │                     │           │                          ▲
   └──► Role, Permission, Base       └──► Base ─────────────────┘
        lodash/isPlainObject
```

* `Base`, `Role` and `Storage` import `RBAC` **only as a Flow type** (`import type`), so there is no runtime cycle.
* `Storage` depends on the concrete entity classes (`Role`, `Permission`) because it uses `instanceof` to tell them apart. Any custom storage therefore has to **rehydrate real `Role`/`Permission` instances** bound to the right `RBAC`, and can't return plain DTOs.
* The only runtime third-party dependency in use is `lodash/isPlainObject`. `keymirror` is declared in `package.json` but **never imported**.

## 3. Layering

```
┌───────────────────────────────────────────────────────┐
│  Caller (Express middleware, Mongoose plugin, app)    │
├───────────────────────────────────────────────────────┤
│  Entities: Role / Permission   (Active-Record-style   │
│            role.grant(), role.can(), perm.add())      │
├───────────────────────────────────────────────────────┤
│  RBAC  (facade: invariants, bulk ops, traversal)      │
├───────────────────────────────────────────────────────┤
│  Storage (abstract)  ──►  Memory | <custom adapter>   │
└───────────────────────────────────────────────────────┘
```

Responsibilities are split like this:

* **RBAC** owns cross-cutting invariants: an item belongs to this instance (`item.rbac !== this`), the parent of a grant is a `Role`, and null checks. It also owns **all query logic**: `traverseGrants`, `can`, `canAny`, `canAll`, `hasRole`, `getScope`. Storages only provide primitive reads and writes, so they never need to understand the hierarchy.
* **Storage** owns persistence of nodes (`add`, `remove`, `get`) and edges (`grant`, `revoke`, `getGrants`). It also gets type-filtered helpers built from those primitives for free (`getRole`, `getPermission`, `exists*`).
* **Entities** hold almost no behaviour. Each method on `Role` forwards to `this.rbac.<method>(this.name, …)`.

The upside is that a new backend only needs about 7 primitive methods, and the traversal is written once. The downside is that the traversal **can't be pushed down** into the backend, such as a recursive CTE in SQL or `$graphLookup` in Mongo. See [03-performance.md](03-performance.md).

## 4. Data model

### Naming and namespacing

Roles and permissions share **one flat namespace keyed by string name**:

* Permission name = `${action}${delimiter}${resource}`, with the delimiter defaulting to `_`.
* Neither role names nor action/resource segments may contain the delimiter or whitespace (`Permission.isValidName`).

So a role name can never collide with a permission name: every permission name contains the delimiter and no role name can. This is the trick that lets one key-value map hold both types.

### Memory layout

```js
items = {
  admin:          { instance: Role,       grants: ['user', 'delete_user'] },
  user:           { instance: Role,       grants: ['create_article'] },
  create_article: { instance: Permission, grants: [] },   // permissions get an (unused) grants array too
}
```

It is an adjacency list: each node keeps an array of outgoing edges by **name** rather than by reference, so removing a node only needs a sweep over every `grants` array.

## 5. Lifecycle and control flow

### Bootstrapping

```js
const rbac = new RBAC({ roles, permissions, grants, storage?, delimiter? });
await rbac.init();   // REQUIRED – the constructor does not seed data
```

1. The constructor merges `DEFAULT_OPTIONS`, picks `options.storage` or a new `Memory()`, and calls `storage.useRBAC(this)`. That binding is one-to-one and enforced.
2. `init()` → `create(roles, permissions, grants)`:
   * `createPermissions` and `createRoles` run **concurrently** (`Promise.all`).
   * Then `grants()` runs every `grantByName` concurrently.
3. It returns `{ permissions: {name: Permission}, roles: {name: Role} }` maps. The JSDoc says arrays.

The constructor is synchronous and seeding is asynchronous. That split exists because storages may be remote, but nothing forces callers to `await init()`, and the instance has no "ready" state.

### Authorization check

```
rbac.can('admin','create','article')
  └─ traverseGrants('admin', cb)              BFS, queue = ['admin'], visited = {admin}
       ├─ storage.getGrants('admin')  → [Role user, Permission delete_user]
       │    ├─ user is Role, unvisited → enqueue
       │    ├─ await cb(user)          → undefined
       │    └─ await cb(delete_user)   → undefined
       └─ recurse with queue ['user']
            └─ storage.getGrants('user') → [Permission create_article]
                 └─ await cb(create_article) → true  ⇒ short-circuit return true
```

The visitor callback returns `undefined` to continue and any other value to stop. `can`, `canAny`, `canAll`, `hasRole` and `getScope` are all thin visitors over this one traversal.

## 6. Public API surface

| Group | Methods |
|---|---|
| Lifecycle | `constructor(options)`, `init()` |
| Node CRUD | `createRole`, `createPermission`, `createRoles`, `createPermissions`, `create`, `add`, `remove`, `removeByName`, `get`, `getRole`, `getRoles`, `getPermission`, `getPermissionByName`, `getPermissions`, `exists`, `existsRole`, `existsPermission` |
| Edge CRUD | `grant`, `revoke`, `grantByName`, `revokeByName`, `grants` |
| Queries | `can`, `canAny`, `canAll`, `hasRole`, `getScope`, `traverseGrants` (documented `@private` but public) |
| Statics | `RBAC.getPermissionNames`, `Permission.createName`, `Permission.decodeName`, `Permission.isValidName` |
| Extension | `Storage` (abstract base), `Base` |

Everything except the statics is `async`. That includes pure in-memory operations, because the API was designed so any backend can be plugged in.

## 7. Evolution (from git history)

* **≤ v5:** callback-based API. It shipped `src/storages/{Memory,Mongoose,MySql,Dynamoose}.js` and an Express helper `controllers/express.js`.
* **v6 (commit `43f5b7a` "async rbac", July 2018):** rewritten to `async/await`. The storage abstraction moved to `src/Storage.js` with a single `Memory` adapter. **The Mongoose, MySQL and Dynamoose adapters and the Express controller were all deleted.**
* The README still advertises DynamoDB support and `import secure from 'rbac/controllers/express'`. **Neither exists in v6**, so the documentation is out of step with the architecture.

## 8. Architectural assessment

**Strengths**
* There is a clear seam between graph semantics (RBAC) and persistence (Storage).
* The single flat namespace with delimiter-based disambiguation is simple and collision-free.
* The traversal is cycle-safe (it keeps a visited set) and can stop early.
* The footprint is tiny, with almost no runtime dependencies.

**Weaknesses and risks**
* Query logic is locked in the application tier, so every check makes O(roles reached) storage round trips.
* `instanceof`-based typing couples storages to concrete classes and breaks when two copies of the package are loaded.
* Writes have no transaction or atomicity contract, so a partially failed `init()` leaves partial state.
* Entities are mutable and hold a back-reference to `rbac`, so they are not plain data and are hard to serialize or cache.
* Only one storage ships, and that one (`Memory`) has broken `getRoles`/`getPermissions` (see [05-correctness-and-code-quality.md](05-correctness-and-code-quality.md)).
* The README promises integrations that were removed.
