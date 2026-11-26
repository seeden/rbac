# Security

An authorization library is a security control itself, so this document looks at two questions: **does it decide correctly** (and fail closed), and **can its inputs be abused**.

Severity scale: **High** = can grant access that shouldn't be granted, or reliably break auth checks. **Medium** = surprising semantics likely to cause a vulnerability in the calling code. **Low** = hardening or hygiene.

## 1. Summary of findings

| # | Finding | Severity |
|---|---|---|
| S1 | `canAll(role, [])` returns **true** (vacuous truth) | **High** (in the caller's context) |
| S2 | Item names collide with `Object.prototype` keys in `Memory` (`constructor`, `toString`, `hasOwnProperty` …) | Medium |
| S3 | With a non-`_` delimiter, `__proto__` is a valid name and **rewires the storage map's prototype** | Medium |
| S4 | Delimiter interpolated into a `RegExp` unescaped, so validation silently breaks for some delimiters | Medium |
| S5 | `hasRole(x, x)` is `true` even when role `x` doesn't exist | Low–Medium |
| S6 | Entity names are mutable after being stored, which desyncs identity from the storage key | Low–Medium |
| S7 | No atomicity: a partially failed `init()` leaves a partially seeded policy | Low–Medium |
| S8 | Errors and exceptions during checks propagate up, so the caller must treat a throw as deny | Low |
| S9 | Cycles in the role graph are allowed, without warning | Low |
| S10 | Supply chain: unpinned, unmaintained toolchain (2019), a git-URL dev dependency, no lockfile | Low |
| S11 | The README points to an Express helper that no longer exists | Low |

## 2. Decision correctness

### What is done well

* **Default deny.** Unknown roles, unknown permissions and roles with no grants all return `false` from `can`/`canAny`/`hasRole` (`return can || false`).
* **Cycle-safe traversal.** `traverseGrants` keeps a `used` set, so `A → B → A` doesn't loop forever. A cycle can't be used to cause a DoS through infinite recursion.
* **Instance isolation.** `add`, `remove`, `grant` and `revoke` reject entities that belong to a different `RBAC` instance (`item.rbac !== this`), and one storage can't be bound to two instances (`useRBAC`).
* **No role/permission confusion.** Role names may not contain the delimiter and permission names always do, so `getRole('create_article')` can't return a permission and vice versa. The tests cover this.
* **Exact matching only.** There are no wildcards or globbing, so no pattern-matching bypasses are possible.

### S1: `canAll` with an empty list grants access (**High**)

```js
// src/RBAC.js:461
const permissionNames = RBAC.getPermissionNames(permissions, ...);   // []
...
return foundedCount === permissionNames.length;   // 0 === 0  → true
```

`canAll('guest', [])`, and even `canAll('nonexistent-role', [])`, returns **`true`**. A very common pattern is `canAll(user.role, requiredPermsFor(route))`. If the per-route lookup returns an empty list because of a typo, a missing route entry or a config bug, every role, including undefined ones, passes. `canAny(role, [])` returns `false`, so the two helpers are also inconsistent with each other.

**Fix:** reject empty input (`throw`) or return `false`, and document it. Also consider rejecting duplicate entries.

### S5: `hasRole` short-circuits before checking existence

```js
if (roleName === roleChildName) return true;
```

`hasRole('ghost', 'ghost')` is `true` even if `ghost` was never created or has been removed. Middleware that does `hasRole(req.user.role, 'admin')` is safe only as long as `req.user.role` can never be attacker-controlled to equal the required role while the role itself is missing. In practice this is low risk. It does mean `hasRole` is **not** a "does this role exist and include X" check.

### S8: Exceptions instead of `false`

Some inputs make the checks **throw** instead of returning `false`:

* `can(role, '', 'x')` doesn't throw, but `canAny/canAll(role, [['', 'x']])` throws (`Action is not defined`) through `createName`.
* With S2, `can('constructor', ...)` throws `TypeError` inside `getGrants`.

This fails closed **only if** the caller's error handling denies. An Express middleware that does `rbac.can(...).then(ok => ok ? next() : deny())` with no `.catch` leaves the request hanging or crashes on an unhandled rejection. One that does `.catch(next)` sends it to the generic error handler. Neither grants access, but neither is a clean 403. Document that **a throw must be treated as deny**, or catch internally and return `false`.

## 3. Input handling and injection

### S2: Prototype-key collision in `Memory` (**Medium**)

`Memory.items` is a plain `{}` object and lookups are `this.items[name]` with no `hasOwnProperty` guard:

```js
// src/Memory.js
if (this.items[name]) throw new Error(`Item ${name} already exists`);
```

With the default `_` delimiter, names such as `constructor`, `toString`, `valueOf` and `isPrototypeOf` pass `isValidName`. Then:

| Call | Result |
|---|---|
| `createRole('constructor', true)` | throws **"Item constructor already exists"**, so the role can't be created |
| `exists('toString')` | `false` (`Function.prototype.instance` is `undefined`), which is correct by accident |
| `can('toString', 'read', 'x')` | `getGrants` → `this.items.toString.grants.reduce` → **TypeError** |
| `grant(role 'valueOf', …)` | passes the existence check (inherited function is truthy) then crashes |

This can't be turned into privilege escalation on its own. It does give an **attacker-influenced role name** (for example one taken from a JWT claim or a tenant-chosen role name) a reliable way to make auth checks throw. Verified with a quick check: `!!({})['constructor'] === true`, `({}).toString.grants === undefined`.

**Fix:** use `Map`, or `Object.create(null)`, or guard with `Object.prototype.hasOwnProperty.call(items, name)`.

### S3: `__proto__` as an item name (**Medium**, non-default delimiter only)

With the default `_` delimiter, `__proto__` is rejected because it contains `_`. With any other delimiter (`:`, `.`, `|`) it is a valid name:

```js
this.items['__proto__'] = { instance: item, grants: [] };   // sets items' [[Prototype]]
```

This **replaces the prototype of that storage's `items` object**. The global `Object.prototype` is untouched, so this is not global prototype pollution. Afterwards, though, lookups of *missing* names resolve through the new prototype: `items['instance']` returns the `__proto__` role object and `items['grants']` returns its array. The item map's integrity is lost, and later `exists`/`get`/`grant` results become unreliable. The same `Map` / `Object.create(null)` fix resolves it.

### S4: Unescaped delimiter in `RegExp` (**Medium**)

```js
// src/Permission.js:130
const exp = new RegExp(`^[^${delimiter}\\s]+$`);
```

The delimiter is dropped into a character class with no escaping. Verified behaviour:

| Delimiter | Effective rule | Consequence |
|---|---|---|
| `_` (default) | not `_`, not whitespace | correct |
| `::` (multi-char) | not `:` | works only by accident. `decodeName` then splits wrongly (`'a::b'` → action `a`, resource `:b`) |
| `]` | regex becomes `^[^]\s]+$` | **every normal name is rejected** (`admin` → invalid) |
| `\` | class becomes `[^\\s]` | **whitespace allowed**, and any name containing the letter **`s`** is rejected (`users` invalid) |
| `-` / `^` | happen to work | — |

When validation silently breaks like this, names that should be distinct can encode to the same permission name. That breaks the role/permission namespace separation described above. **Fix:** require a single-character delimiter and escape it (`delimiter.replace(/[\\\]^-]/g, '\\$&')`), or validate without a regex (`!name.includes(delimiter) && !/\s/.test(name)`).

### S6: Mutable identity

`Base` exposes `name` and `rbac` as plain writable properties. `Permission` caches `_action`/`_resource`. After storage:

```js
const admin = await rbac.getRole('admin');
admin.name = 'superadmin';        // storage key is still 'admin'
await admin.can(...);             // now queries 'superadmin'
```

Memory hands out **the stored instance itself** rather than a copy. Any code that holds a role object can therefore change what later checks resolve to. That code is already trusted, so this is hardening, not a vulnerability. **Fix:** `Object.defineProperty(this, 'name', { writable: false })` or private class fields.

## 4. Integrity of the policy

### S7: Non-atomic seeding

`create()` runs creations concurrently and doesn't roll back. Examples:

* A duplicate role name in `roles` makes one `add` reject. `Promise.all` rejects, **the other roles stay created**, and `grants` never runs.
* A grant that references an unknown name fails with `"One of item is undefined"`, which doesn't say which name. The other grants (running concurrently) may or may not have been applied.

A service that catches this error at startup and carries on is left with an **unpredictable, partially applied policy**. That is usually fail-closed (missing grants), but not necessarily, for example when a revoke-style migration is half applied. **Recommendation:** validate the whole config before mutating, and fail hard at boot.

### S9: Cycles are allowed

`grant(A, B)` followed by `grant(B, A)` is accepted, which makes A and B equivalent. The traversal handles it safely, but it is almost always a configuration mistake that silently widens privileges. Consider rejecting a grant that would create a cycle (`hasRole(child, parent)` before granting).

## 5. Dependency and supply-chain posture

| Item | Observation |
|---|---|
| Runtime deps | `lodash@^4.17.14`: only `isPlainObject` is used. The floor is past the 2019 `defaultsDeep` prototype-pollution fix but below later lodash advisories (e.g. 4.17.21 for `template`/`zipObjectDeep`). Not exploitable through this usage, but it will show up in audits. `keymirror` is **unused** and can be removed. |
| Dev deps | about 45 packages from 2019 (Babel 7.5, Jest 24, ESLint 6, gulp 4, jsdoc 3). Many have published advisories in their transitive trees. They don't affect consumers because they aren't shipped, but they do affect maintainers and CI. |
| `babelify` from `git+https://github.com/...#master` | **unpinned git dependency on a moving branch**, which is a classic supply-chain risk. It is also unused by any script. |
| `@babel/preset-stage-1` | doesn't exist as a Babel 7 package, so installs may fail or resolve to something unexpected |
| Lockfile | `package-lock.json` is **gitignored and was deleted** (commit `ca4a9b4`), so builds are not reproducible |
| Published artifact | `.npmignore` excludes `src`, and `dist/` is built on `prepublish` from whatever the machine resolved. There is no provenance. |

## 6. Operational guidance for consumers

1. Treat **any thrown error from `can*`/`hasRole` as deny**.
2. **Never call `canAll` with a list that could be empty.**
3. Keep the **default `_` delimiter**, or a single safe character such as `:`. Don't use `]`, `\` or multi-character delimiters.
4. Don't accept role or permission **names from untrusted input** without an allow-list. In particular, reject `__proto__`, `constructor` and `prototype`.
5. Validate the policy config at startup and **crash on `init()` failure**. Don't continue with a partial policy.
6. Remember the library has no user/subject model, no audit logging, and no resource-instance checks. Those belong to the calling layer.
