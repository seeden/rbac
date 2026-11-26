# rbac: Code Base Deep Dive

This is an analysis of `rbac` v6.0.0 (`master` @ `d3eea5d`), a hierarchical role-based access control library for Node.js.

| # | Document | Covers |
|---|---|---|
| 1 | [Architecture](01-architecture.md) | module map, layering, data model, lifecycle, API surface, evolution from v5 |
| 2 | [Design Patterns](02-design-patterns.md) | Facade, Repository/Strategy, Template Method, delegating entities, Visitor traversal, missing patterns |
| 3 | [Performance](03-performance.md) | traversal complexity, N+1 storage access, caching, write paths, optimization roadmap |
| 4 | [Security](04-security.md) | decision correctness, fail-closed behaviour, injection and prototype issues, policy integrity, supply chain |
| 5 | [Correctness & Code Quality](05-correctness-and-code-quality.md) | concrete bugs, type-system gaps, test suite, lint, quick-win fixes |
| 6 | [Build, Tooling & Maintenance](06-build-tooling-and-maintenance.md) | Babel and Flow decisions, packaging, dependencies, docs, CI, modernization plan |

## Top findings at a glance

1. **`Memory#getRoles()` / `getPermissions()` always throw.** `items` is a plain object, but the code calls `.reduce` on it ([src/Memory.js:97](../src/Memory.js:97)).
2. **`canAll(role, [])` returns `true`** for any role, even one that doesn't exist. That is a dangerous default for an authorization check.
3. **The item store is a plain `{}`**, so names like `constructor` and `toString` collide with built-ins and make checks throw. With a non-default delimiter, `__proto__` can rewire the map.
4. **Delimiter handling is fragile.** It is interpolated into a regex without escaping, and decoding assumes a one-character delimiter.
5. **Every check walks the role graph from scratch** with one sequential storage call per role and no caching. That is fine in memory, but costly with remote storages, which the design targets.
6. **The tooling is from 2018–2019 and CI is dead** (Travis). It has an unpinned git dependency, no lockfile, unchecked Flow types, and a README that advertises removed features.

## Fix status

Findings 1–4 are **fixed** in the working tree, with regression tests in [src/regressions.test.js](../src/regressions.test.js):

| Finding | Fix |
|---|---|
| 1. `getRoles`/`getPermissions` throw | `Memory` now stores items in a `Map` and lists `values()` |
| 2. `canAll(role, [])` is `true` | empty (or non-array) input to `canAll`/`canAny` returns `false`. `canAll` also dedupes its input. |
| 3. Prototype-key names | `Memory.items` is a `Map`. The `traverseGrants` visited-set and the `canAll` found-set are `Set`s. Before, a child role named `constructor` was silently skipped during traversal. |
| 4. Delimiter handling | `isValidName` compares characters instead of building a `RegExp`, and `decodeName` slices at `pos + delimiter.length` |

Finding 5 (tooling, CI, README) is still open. The other findings in the category docs (S5–S11, B6–B8, performance) are also still open, except that `traverseGrants` is now an iterative loop instead of recursion.

## Method

I read every source, config and test file in the repo and checked the git history (including the v6 rewrite in `43f5b7a` that removed the storages). I confirmed the suspected JavaScript behaviours (prototype keys on `{}`, the regex results for each delimiter, multi-character decoding) by running small snippets in Node 20. I didn't run the Jest suite, because `node_modules` isn't installed.
