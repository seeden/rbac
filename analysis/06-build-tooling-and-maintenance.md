# Build, Tooling, Packaging & Maintenance Decisions

## 1. Language and transpilation

### Decision: ES2018+ source, transpiled to Node 6.10

[babel.config.js](../babel.config.js):

```js
["@babel/env", { targets: { node: "6.10" }, useBuiltIns: "entry", loose: true }]
```

* **Why it made sense in 2018:** `package.json` declares `engines.node >= 6.1.0`, so async/await, object spread and class properties all had to be down-levelled.
* **Today:** Node 6–16 are all end-of-life. The output uses `regenerator` state machines, which are slower and harder to debug than native async functions, and it may need `regeneratorRuntime` to be available globally.
  * `useBuiltIns: 'entry'` only takes effect if the source does `import '@babel/polyfill'`, and it never does. The setting does nothing, and consumers on old Node may hit a missing `regeneratorRuntime`.
* **About 17 Babel proposal plugins are enabled**: pipeline operator, do-expressions, function.sent, throw-expressions, decorators (legacy), and more. The code uses **only two non-standard features**: `export X from` (export-default-from) in `index.js`, and class properties in `Memory.js` (now standard). The rest is a copy-pasted "kitchen sink" config. It slows builds and makes it easy to start using syntax that will never be standardized.
* `api.cache(false)` turns off Babel's config caching, so every file re-evaluates the config.

**Recommendation:** target a current LTS (`node: 18`+), drop every proposal plugin except class properties (or none at all), and rewrite `index.js` to use `export { default as RBAC } from './RBAC'`.

### Decision: Flow annotations, without Flow

See [05-correctness-and-code-quality.md §2](05-correctness-and-code-quality.md). The types are stripped and never checked. Consumers get no `.d.ts` or `.js.flow` files, so TypeScript users get no typings from this package.

## 2. Packaging

| Aspect | Current | Notes |
|---|---|---|
| Entry | `"main": "./dist/index.js"` (CommonJS via Babel) | no `exports` map, no ESM build, no `types` |
| Consumer import | `require('rbac').default`? | `index.js` uses only **named** exports, so `require('rbac').RBAC` is correct. The README's ES5 example (`require('rbac').default`) is **wrong**. |
| Build trigger | `"prepublish": "npm run build"` | `prepublish` also runs on a local `npm install` (deprecated behaviour). `prepare` or `prepublishOnly` is the modern choice. |
| Build output | `babel ./src --out-dir ./dist --source-maps --copy-files` | `--copy-files` and the co-located test mean **`RBAC.test.js` is compiled into `dist/` and published** |
| Published files | `.npmignore` excludes `src` | uses a blacklist. A `files: ["dist"]` whitelist is safer and also leaves out `analysis/`, configs and so on. |
| Lockfile | gitignored and deleted | non-reproducible builds (see the security doc) |

## 3. Dependencies

* **Runtime:** `lodash` is used for one function (`isPlainObject`) and could be replaced with a three-line check. `keymirror` is **unused**.
* **Dev:** about 45 packages, many of them unused:
  * React tooling (`@babel/preset-react`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, `babel-loader`, `eslint-loader`) in a non-React, non-webpack library.
  * Two documentation toolchains at once: `jsdoc` + `gulp-jsdoc3` + `jaguarjs-jsdoc` + `gulp` + `gulp-babel` + `gulp-util` (deprecated), **and** `documentation`.
  * `babelify` from an unpinned git branch, plus `babel-core@7.0.0-bridge.0`, a shim that is only needed for old tools.
  * `@babel/preset-stage-1`, which doesn't exist in Babel 7.
  * `jest-cli` alongside `jest` (redundant), and `should` alongside Jest's own `expect`.

## 4. Documentation pipeline

* `npm run doc` → gulp → jsdoc → `./docs/gen`
* `npm run docs:build` → `documentation build src/**` → `./docs`
* The README links to `http://seeden.github.io/rbac/RBAC.html` (GitHub Pages, plain HTTP).

These are two competing generators, and neither runs in CI. The JSDoc content itself has several errors (see the correctness doc §B6), so generated docs would be misleading.

## 5. CI / CD

[.travis.yml](../.travis.yml):

* `dist: precise` (Ubuntu 12.04, long retired by Travis) and `sudo: required`.
* Node 6–10 matrix: all EOL, and none of them is the Node version a consumer would use today.
* Runs `npm test` only. There is **no lint, no build check, no coverage upload** (despite the Coveralls badge), and no `npm audit`.
* Travis-CI.org has shut down, so CI is effectively **not running**.

**Recommendation:** GitHub Actions on Node 18/20/22 running lint → test (with coverage) → build. Add Dependabot/Renovate, and publish with npm provenance.

## 6. Versioning and history

* `HISTORY.md` only points to GitHub Releases. There is no in-repo changelog.
* The v5 → v6 change (callbacks → promises, external storages removed) was a large breaking change. The README was only partly updated: it still shows the Express controller and DynamoDB claims.
* The last functional change was in 2018–2019. The most recent commit adds `FUNDING.yml`. In practice the project is **in maintenance-only / dormant mode**.

## 7. Repository hygiene

| Item | Observation |
|---|---|
| `.gitignore` | lists Bower and Sass cache folders, `public/lib`, etc., left over from a template |
| `.eslintignore` | ignores `controllers`, `example` and `tests`, which no longer exist |
| `gulpfile.js` / `jsdocConfig.js` | ES-module syntax that runs only through `babel-node`. `jsdocConfig.js` has a commented-out tail. |
| `LICENSE` vs README | README says © 2016–2018 |

## 8. Recommended modernization plan

1. **Toolchain:** Node 18+ target, minimal Babel (or switch to TypeScript and emit `.d.ts` files), ESLint flat config without the React plugins, Prettier.
2. **Packaging:** dual ESM/CJS with an `exports` map, a `files` whitelist, `prepublishOnly`, and a committed lockfile.
3. **Tests:** move them to `test/`, make them independent and negative-case-heavy, run a shared contract-test suite against any `Storage` implementation, and enforce a coverage threshold.
4. **Docs:** one generator, publish from CI, and fix the README (remove the Express/DynamoDB claims, fix the CommonJS import example).
5. **Dependencies:** remove `keymirror`, `lodash`, `babelify` and the React/webpack/gulp tooling.
6. **CI:** GitHub Actions with lint, test, build and audit, plus Dependabot.
