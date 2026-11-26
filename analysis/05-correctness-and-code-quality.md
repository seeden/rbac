# Correctness & Code Quality

These are functional bugs and maintainability issues found by reading the code and checking specific JavaScript behaviours in Node 20. Line references are to `master` @ `d3eea5d`.

## 1. Functional bugs

### B1: `Memory#getRoles` / `getPermissions` always throw (**High**)

```js
// src/Memory.js:8
items: Object[] = {};          // typed as array, initialised as plain object
...
// src/Memory.js:97
return this.items.reduce(...)  // {}.reduce is undefined → TypeError
```

`rbac.getRoles()` and `rbac.getPermissions()` reject with `TypeError: this.items.reduce is not a function` on the **only storage that ships**. The tests never call them, which is why this went unnoticed. **Fix:** `Object.values(this.items).reduce(...)`.

### B2: Multi-character delimiters decode incorrectly

`decodeName` uses `name.substr(pos + 1)`, which assumes `delimiter.length === 1`. With `delimiter: '::'`, `decodeName('create::article')` → `{ action: 'create', resource: ':article' }`, so `Permission#can('create', 'article')` is always `false`. **Fix:** `pos + delimiter.length`, or restrict the delimiter to one character.

### B3: Delimiter validation regex is unescaped

`isValidName` builds `new RegExp(\`^[^${delimiter}\\s]+$\`)`. A delimiter of `]` rejects every name, and `\` lets whitespace through and rejects any name containing `s`. See security finding S4.

### B4: Prototype-key names break `Memory`

`createRole('constructor', true)` throws "already exists", and `can('toString', …)` throws `TypeError`. The cause is lookups on a plain `{}`. See security finding S2.

### B5: `canAll(role, [])` returns `true`

This is vacuous truth, and it contradicts `canAny(role, []) === false`. See security finding S1.

### B6: Return-type and doc mismatches

| API | Docs / types say | Actually returns |
|---|---|---|
| `createRoles`, `createPermissions` | `Role[]`, `Permission[]` | `{ [name]: entity }` objects |
| `Role#getScope` | `Permission[]` | `string[]` (names) |
| `grantByName`, `revokeByName` | `void` | `boolean` |
| every `async` method | `boolean`, `Role`, … | `Promise<…>` (Flow would reject these) |
| `Base#add` | `@method Base#remove` | `add`, a copy-paste error |
| `Base` constructor | `@param cb Callback` | no callback (left over from v5) |
| `traverseGrants` | `@private`, `@method RBAC#_traverseGrants` | public, without an underscore |

### B7: Misleading error messages

* `Memory#grant`: `"You can grant yourself ${name}"`, which should say *can't*.
* `Memory#revoke`: `"Role is not exist"` even when the **child** is missing.
* `RBAC#grantByName` with an unknown name: `"One of item is undefined"`, which doesn't name the missing item.
* `Permission.isValidName`: `"Delimeter is not defined"` (typo).
* `Permission` getters' `if (!decoded) throw` branches are unreachable, because `decodeName` either returns an object or throws.

### B8: Option key typo

`DEFAULT_OPTIONS.grant = {}` is never read. The code uses `options.grants`. This is harmless today but misleading.

### B9: `hasRole(x, x)` is `true` for non-existent roles

See security finding S5.

## 2. Type system: Flow in name only

* Files start with `// @flow` and use type annotations, but there is **no `.flowconfig` and no `flow-bin`**, and no script runs Flow. Babel just strips the types.
* Many annotations would fail a real Flow check: `async f(): boolean` should be `Promise<boolean>`, `items: Object[] = {}`, and `next: String[]` uses the boxed `String`. B1 is exactly the kind of bug a type checker would have caught.
* `import type RBAC from './RBAC'` in `Permission.js` is missing, even though `RBAC` is used as a type there.

**Recommendation:** either enable real type checking (TypeScript would also give consumers `.d.ts` files) or drop the annotations so they don't give false confidence.

## 3. Test suite

[src/RBAC.test.js](../src/RBAC.test.js) is a **single, order-dependent scenario**: about 30 `it` blocks that share mutable `rbac` and `response` variables and only pass when run in sequence.

| Gap | Effect |
|---|---|
| No `getRoles` / `getPermissions` test | B1 shipped |
| No negative or edge tests (`canAll([])`, cycles, duplicate names, custom delimiters, reserved names) | B2–B5 shipped |
| No error-path tests other than one `getPermission('admin','')` | error messages and behaviour unverified |
| No custom `Storage` adapter test | the extension contract is untested |
| Test is **inside `src/`** and imports `'../src/index'` | works only because of the path. Babel's `--copy-files` build also **copies the test into `dist/`**, where that import path is broken. |
| `should` assertions mixed with Jest `expect` | two assertion libraries for no gain |
| Commented-out Mongoose/MySQL/Dynamoose suites | dead code that references removed modules |

There is a coverage script, but no threshold is enforced and the Coveralls badge in the README is stale.

## 4. Lint and style

* ESLint uses `airbnb` plus `react` and `jsx-a11y` plugins in a library with no React code.
* Rules that would fire if lint were enforced: `consistent-return` (`can` visitor, `traverseGrants`), `no-param-reassign` (`used[...] = true`), `no-underscore-dangle` (`_action`), `class-methods-use-this` (abstract storage methods), `no-unused-vars` (abstract parameters). Lint isn't part of `test` or CI, so drift is invisible.
* `String#substr` is deprecated. Use `slice`.
* Double blank lines in `RBAC.js` (lines 367–368 and 429–430) suggest the files are not auto-formatted.

## 5. Maintainability scorecard

| Dimension | Rating | Notes |
|---|---|---|
| Size / readability | ★★★★☆ | small, well-named, JSDoc on every method |
| Cohesion | ★★★★☆ | clear storage/graph split |
| Correctness | ★★☆☆☆ | the shipped storage has broken list methods and delimiter handling is fragile |
| Test depth | ★★☆☆☆ | happy path only, order-dependent |
| Type safety | ★☆☆☆☆ | Flow annotations are not checked and are often wrong |
| Docs accuracy | ★★☆☆☆ | README advertises removed features, and JSDoc return types are wrong |

## 6. Quick-win fix list

1. `Object.values(this.items)` in `Memory#getRoles/getPermissions`, plus tests.
2. Switch `Memory.items` to a `Map` (fixes B4 and S3).
3. Single-character delimiter: escape it in the regex and use `pos + delimiter.length` in `decodeName`.
4. `canAll` / `canAny` with an empty list → throw or `false`.
5. Fix the JSDoc return types, the error messages and the `grant`/`grants` option typo.
6. Split the test into independent `describe` blocks with `beforeEach` setup, and add negative tests.
7. Move tests out of `src/`, or exclude `*.test.js` from the Babel build.
