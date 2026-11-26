# Design Patterns

This lists the patterns the code base uses, deliberately or not, and how well each one is carried out.

## 1. Facade: `RBAC`

[src/RBAC.js](../src/RBAC.js) is the single entry point. It wraps the storage behind a larger, friendlier API: bulk creation, by-name variants, and the queries. Callers don't touch `Storage` directly.

* **Good:** invariant checks (`item.rbac !== this`, `role instanceof Role`) live in one place.
* **Smell:** many methods are one-line pass-throughs (`exists`, `existsRole`, `getRole`, `getRoles`…), so the class mixes a facade with a service layer. That is fine at this size.

## 2. Repository / Strategy: `Storage` → `Memory`

[src/Storage.js](../src/Storage.js) is an abstract repository. [src/Memory.js](../src/Memory.js) is one interchangeable strategy for it, chosen by dependency injection through `new RBAC({ storage })`.

```js
this.storage = this.options.storage || new MemoryStorage();   // default strategy
this.storage.useRBAC(this);                                   // back-binding
```

* JavaScript has no abstract classes, so "abstract" is imitated with methods that `throw new Error('… not implemented')`. A missing method only fails **at runtime, on first call**, not when the adapter is built.
* The back-binding (`useRBAC`) is a **two-way association**. The storage needs `rbac.options.delimiter` to build permission names in `getPermission`. Calling `useRBAC` a second time throws, which enforces **one storage per RBAC instance**.

## 3. Template Method: derived storage helpers

`Storage` implements `getRole`, `getPermission`, `exists`, `existsRole` and `existsPermission` **in terms of** the abstract `get()`:

```js
async getRole(name) {
  const role = await this.get(name);
  return role instanceof Role ? role : undefined;
}
```

Adapters only override the primitives and get the rest for free, which is the classic Template Method shape. The cost is that the helpers can't be optimized per backend unless they are overridden too. For example, `exists` fetches the whole entity just to test whether it exists.

## 4. Active Record-ish entities (delegating)

`Role` and `Permission` extend `Base` ([src/Base.js](../src/Base.js)), which holds a reference to its `rbac`:

```js
role.add();             // → rbac.add(role)       → storage.add(role)
role.grant(perm);       // → rbac.grant(role, perm)
role.can('create','article'); // → rbac.can(role.name, ...)
```

These aren't true Active Record objects, since they don't persist themselves. They are more like **delegating proxies** that give the facade an object-oriented feel. This leads to:

* **Bidirectional coupling:** entity → RBAC → storage → entity.
* Entities that **can't be serialized** naively (`JSON.stringify(role)` walks into `rbac` → `storage` → `items` → back to `role`, a cycle).
* Two ways to do everything (`role.can(...)` vs `rbac.can(role.name, ...)`).

## 5. Value object / codec: permission names

`Permission` has static `createName`, `decodeName` and `isValidName`. Together they work as a **codec** between the tuple `(action, resource)` and the string key. The tuple form exists only on the object (lazily decoded through the `action`/`resource` getters). The string is the canonical identity used in storage and comparisons.

* **Lazy memoization:** the getters decode on first access and cache the result in `_action`/`_resource`. Since the name is already known at construction, it would be simpler to store the parts directly.
* The codec **assumes a one-character delimiter** (`substr(pos + 1)`), while `createName`/`isValidName` accept any string. The three functions disagree (see the correctness doc).

## 6. Visitor over graph traversal

`traverseGrants(roleName, cb)` performs a breadth-first search and calls `cb(item)` for each edge target. The visitor's return value controls the flow:

| Return | Meaning |
|---|---|
| `undefined` | continue |
| anything else | stop the traversal and propagate that value |

Every query is a small visitor:

| Query | Visitor logic | Stops early? |
|---|---|---|
| `can` | permission matches `(action, resource)` | yes, on first match |
| `canAny` | permission name ∈ list | yes, on first match |
| `canAll` | counts distinct matches | yes, once all are found |
| `hasRole` | role name matches | yes |
| `getScope` | collects permission names | no, full walk |

This is a neat, reusable abstraction. It does have quirks:

* The traversal state (`next`, `used`) is passed as **optional public parameters** with mutable defaults, so a caller could pass `next`/`used` and change the walk.
* It uses **recursion for iteration**: each BFS level, really each dequeued node, is a recursive `async` call. A `while (queue.length)` loop would be clearer.
* "Return `undefined` to continue" is fragile. A visitor that accidentally returns `false` or `null` stops the search. The `can` visitor relies on implicitly returning `undefined`, and ESLint's `consistent-return` would flag it.

## 7. Builder-ish bulk declaration

`new RBAC({ roles, permissions, grants })` followed by `init()` acts as a **declarative configuration builder**: you describe the whole policy as data and the library materializes it.

```js
permissions: { article: ['create', 'update'] }   // resource → actions
grants:      { admin: ['user', 'delete_user'] }   // role → child names
```

* The configuration is **data-driven** and easy to keep in JSON or YAML, which is good.
* The shapes are inconsistent across the API. `permissions` here is `{resource: actions[]}`, `canAny`/`canAll` take `[[action, resource]]` tuples, and grants refer to permissions by their **encoded** name (`delete_user`), which ties config files to the delimiter.
* `DEFAULT_OPTIONS` defines `grant: {}` (singular) while the code reads `options.grants` (plural), a leftover typo.

## 8. Dependency Injection (constructor)

The storage is injected through options and defaults to `Memory`. There is no factory or registry. One adapter instance can serve only one RBAC (`useRBAC` guard), which stops two RBAC instances from accidentally sharing state.

## 9. Error-signalling convention

Every failure is a thrown generic `Error` with a free-text message. There are no error classes or codes:

* Callers can't tell "role not found" from "invalid name" from "storage down" without matching on message strings.
* Query methods mix two styles: `get*` returns `undefined` for "not found", but `revoke` throws when the edge doesn't exist and `add` throws when the item already exists.
* Some messages are wrong or misleading: `"You can grant yourself"` (should be *can't*), `"Role is not exist"` for a missing **child** in `revoke`, and `"Delimeter"` (typo).

## 10. Patterns that are *missing* but would fit

| Pattern | Why |
|---|---|
| **Unit of Work / transaction hook** on `Storage` | make `create()`/`init()` atomic and avoid half-seeded state |
| **Cache-aside / memoized closure** | the role graph rarely changes, so precomputing the transitive closure per role turns `can()` into O(1) (see performance doc) |
| **Typed error hierarchy** (`NotFoundError`, `ValidationError`, `ConflictError`) | lets callers handle errors programmatically and helps fail-closed handling |
| **Type tags instead of `instanceof`** (e.g. `item.type === 'role'`) | lets adapters return plain objects and avoids the dual-package hazard |
| **Immutable entities** (`Object.freeze`, private fields) | stops `role.name = 'x'` from silently desyncing from the storage key |
