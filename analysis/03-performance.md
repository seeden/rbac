# Performance

Notation: **R** = roles reachable from the queried role, **E** = grant edges among them, **N** = total items in storage, **P** = permissions passed to `canAny`/`canAll`, **S** = size of the resulting scope.

## 1. Hot path: `can()` and friends

All queries go through `RBAC#traverseGrants` ([src/RBAC.js:387](../src/RBAC.js:387)), a breadth-first search.

| Operation | Time (Memory storage) | Storage round trips |
|---|---|---|
| `can` | O(R + E) worst case, can stop early | up to **R sequential** `getGrants` calls |
| `canAny` | O(E · P), since `Array#includes` on the name list | up to R |
| `canAll` | O(E · P) | up to R, all of them if any permission is missing |
| `hasRole` | O(R + E) | up to R |
| `getScope` | O((R + E) · S), since `scope.includes` makes it quadratic | **always R** (no early stop) |

### 1.1 Sequential N+1 storage access

```js
const grants = await this.storage.getGrants(actualRole);   // one call per role, in series
for (...) { const result = await cb(item); ... }            // await per edge, even for sync callbacks
```

* **One round trip per reachable role, strictly in series.** With Memory that costs only microtask hops. With a remote store (Mongo, SQL, DynamoDB, which v5 supported and the design still targets) a check on a role five levels deep takes at least five network round trips, and each BFS level could have been batched (`getGrants([...names])`).
* **`await cb(item)` on every edge.** All built-in visitors are synchronous, yet each `await` still yields to the microtask queue. For a role with 200 permissions that means 200 extra microtask turns per check.

### 1.2 No caching or precomputation

Role hierarchies are usually **read-heavy and change rarely**, yet every `can()` walks the graph from scratch. Common fixes:

1. **Materialize each role's transitive closure** as a `Set<permissionName>` and invalidate it on `grant`/`revoke`/`remove`. `can()` becomes an O(1) `Set#has`.
2. Failing that, **memoize `getScope(role)`** and keep `can()` as a lookup into it.
3. For SQL or Mongo adapters, push the traversal into the database (recursive CTE / `$graphLookup`). The current `Storage` contract has no hook for this.

### 1.3 Avoidable work inside visitors

* `canAny`/`canAll` build `permissionNames` as an **array** and then call `.includes` inside the loop. A `Set` makes each check O(1).
* `getScope` dedupes with `scope.includes(...)`, which is O(S²). A `Set` makes it O(S).
* `Permission#can(action, resource)` compares the decoded parts. Comparing `item.name === createName(action, resource)` once is cheaper and also avoids the lazy decode on the first call.

### 1.4 Recursion as iteration

`traverseGrants` calls itself once per dequeued node. In an `async` function the stack unwinds at each `await`, so this **does not** overflow the call stack. It does build a chain of R nested promises, each resolving to the next, which uses O(R) memory and adds a little latency per level. A plain `while (next.length)` loop removes that overhead and is easier to read.

## 2. Write paths

### 2.1 `Memory#remove`: O(N · G)

```js
Object.keys(items).forEach((itemName) => {
  items[itemName].grants = grants.filter(grant => grant !== name);   // rebuilds EVERY grants array
});
```

Removing one item scans **every** node and **reallocates** every `grants` array, even arrays that never referenced it. A reverse index (`parents: Set`) would make removal O(in-degree).

### 2.2 Grant edges stored as arrays

`grants.includes(childName)` (on `grant`) and `grants.filter(...)` (on `revoke`) are O(out-degree). A `Set` per node gives O(1) membership and removal.

### 2.3 Bulk creation concurrency

`create()` runs `createPermissions` and `createRoles` in parallel, then `grants()` fires every `grantByName` at once. Each of those does two `get` calls in parallel.

* With Memory this is harmless.
* With a remote store it is **unbounded concurrency**: a policy with 1,000 grants opens about 2,000 simultaneous reads plus 1,000 writes. There is no batching and no concurrency limit.

## 3. Micro-level costs

| Location | Issue |
|---|---|
| `Permission.isValidName` | compiles a **new `RegExp` on every call**. It runs once per role, and twice per permission, at construction. Caching it per delimiter would avoid this. |
| `Permission` getters | lazy decode plus memoize into `_action`/`_resource`, a needless branch since the parts are known in the constructor |
| `RBAC.getPermissionNames` | re-encodes the input tuples on every `canAny`/`canAll` call. This is fine, but callers can't pass pre-built names. |
| Build target | Babel targets **Node 6.10**, so `async/await` is transpiled to `regenerator` state machines (with `useBuiltIns: 'entry'`). On any modern Node this is **slower and larger** than native async functions. |

## 4. Memory footprint

* Each `Permission` carries an unused `grants: []` array in `Memory`.
* Each entity holds a reference to `rbac`. That is cheap, but it means entities can't be garbage-collected on their own and can't be shared across instances.
* `Memory.items` is a plain object used as a hash map. V8 handles thousands of keys fine, but a `Map` is the better fit for dynamic string keys: no prototype lookups, predictable iteration, and better handling of deletion-heavy workloads.

## 5. Suggested optimization roadmap (by impact)

1. **Cache the transitive closure** per role in `RBAC` and invalidate it on mutation. This turns every check into roughly O(1) with zero storage calls.
2. **Batch BFS levels**: extend the `Storage` contract with `getGrantsMany(names[])` so a remote check costs depth-many round trips instead of R.
3. Replace arrays with **`Set`s** in `canAny`, `canAll`, `getScope` and the Memory grants lists.
4. Stop `await`ing synchronous visitors, or check `result instanceof Promise` first.
5. Use a `Map` and a reverse-edge index in `Memory`.
6. Raise the Babel target to a supported Node LTS so async functions stay native.

None of this matters for small, in-memory policies, which are what the library actually ships with. The design, though, explicitly aims at remote storages, and that is where the N+1 traversal hurts most.
