# FTP Browser — agent guide

## Overview

Electron desktop FTP/FTPS browser. The main process (`src/main`) owns all I/O as services: the
basic-ftp connection, a transfer queue over a pool of parallel connections (large WAN downloads
split into segments), sharp thumbnails in a disk cache indexed in SQLite (better-sqlite3, which
also stores saved servers), local file operations, and auto-update (electron-updater, packaged
Windows installer only). The renderer (`src/renderer/src`, React 19 + zustand + Tailwind) shows
remote and local panes side by side in list/grid views, in 11 UI locales. The two sides talk only
through the preload bridge `window.api`.

## Source map

- `src/main/index.ts` — bootstrap: creates the window and DB, calls every `register*Handlers`.
- `src/main/`: `ftp/` connection manager and remote file ops · `transfer/` queue, client pool,
  segmented download · `thumbnail/` generator + SQLite cache · `local/` local FS and thumbnails ·
  `db/` `database.ts`, `servers.ts`, `migrations/` · `ipc/` one `<domain>Handlers.ts` per domain ·
  `update/` `UpdateManager` · `operation/` copy/move/delete progress · `debug/` DevTools shortcuts ·
  `menu/`, `preview/`, `utils/` (`errorClassifier.ts`, `remotePath.ts`, `sparseFile.ts`).
- `src/preload/index.ts` + `index.d.ts` — the only bridge; exposes `window.api`.
- `src/renderer/src/`: `components/<area>/` (remote, local, transfer, server, settings, thumbnail,
  layout, common) · `stores/` one zustand `use*Store.ts` each · `hooks/` · `lib/` pure helpers ·
  `i18n/` · `test/rendererTestUtils.ts`.
- `src/shared/` — imported by both sides: `types/` (incl. `ipc.ts`), `constants.ts`, `debug.ts`,
  plus repo contract tests. Aliases: `@shared/*` everywhere, `@renderer/*` in renderer and vitest.
- `script/` — dev helpers and `smoke-packaged.mjs`. `docs/handoff/` — feature specs (see below).

## IPC contract

- Channels are `domain:action` (`ftp:list`, `transfer:enqueue`); main→renderer events use the same
  shape (`transfer:updated`) via `win.webContents.send`; `window.api.on` returns an unsubscribe.
- Every `ipcMain.handle` returns `IpcResult<T>` from `src/shared/types/ipc.ts`
  (`{ success: true, data }` | `{ success: false, error, code? }`). Return failures as values:
  `catch (err) { return ipcError(err) }` (`src/main/utils/errorClassifier.ts`).
- A new channel must be added in three places, or it fails only at runtime:
  1. `ipcMain.handle` in `src/main/ipc/<domain>Handlers.ts` (a new handlers file is also
     registered in `src/main/index.ts`);
  2. the `INVOKE_CHANNELS` / `EVENT_CHANNELS` allow-list in `src/preload/index.ts`;
  3. the `InvokeChannel` / `EventChannel` union in `src/preload/index.d.ts`.
- Renderer tests replace `window.api` with a mock, so they cannot catch a missing allow-list entry.
  Cover new channels in `src/preload/index.test.ts` (see Test-208) and try them in the running app.
- `IPC_CHANNELS` in `src/shared/types/ipc.ts` is a stale list nothing imports, not the registry.

## Commands

- `npm test` — whole vitest suite once (~25 s). `npm run test:watch` — watch mode.
- One file: `npx vitest run src/main/db/servers.test.ts`. One test: add `-t "<name substring>"`
  (matches `describe`/`it` names, not `covers:` tags).
- `npm run typecheck` (node + web tsconfigs) · `npm run lint` / `lint:fix` · `npm run format:check`.
- `npm run dev` — electron-vite with HMR; `npm run dev -- -- --devtools` turns DevTools on.
- `npm run build` — typecheck + `electron-vite build` into `out/`. `npm run build:unpack` — build +
  `electron-builder --dir` into `dist/`. `npm run smoke:packaged` — launches the single unpacked app
  in `dist/` with `--smoke-test`; run `build:unpack` first.
- `npm run test:mutation` — Stryker over the `mutate` list in `stryker.config.json`.
- `npm run test:coverage` currently fails: its provider `@vitest/coverage-v8` is not installed.
- `script/{setup,run,test,lint}.sh` have `.ps1` twins; change both together. `script/package.ps1`
  (Windows x64 installer + portable) has no `.sh` twin. `.ps1` files are UTF-8 BOM + CRLF, all
  else LF (`.gitattributes`). `./script/lint.sh` with no argument means `fix`: it rewrites files
  repo-wide (`eslint --fix`, `prettier --write .`); use `check` to only verify.
- Before committing: `npm run typecheck && npm run lint && npm test`, then
  `npx prettier --check <files you changed>`. Repo-wide `format:check` already fails on some
  `docs/handoff/*.md` files.
- CI (`.github/workflows/ci.yml`, push to main and PRs; Windows x64, Linux x64, macOS arm64/x64):
  `npm ci` → `npm test` → `npm run build:unpack` (includes typecheck) → `npm run smoke:packaged`
  (Xvfb on Linux). CI does not run lint or Prettier.

## Tests

- vitest with `globals: true`; the default environment is `node`. Renderer component/hook tests
  that need a DOM put `/** @vitest-environment jsdom */` on the first line.
- Tests are co-located `*.test.ts(x)` (plus `script/*.test.mjs`); test names are English.
- Main-process tests `vi.mock('electron', () => ({ ... }))` with only what the module uses (often
  `app.getPath`). better-sqlite3 13 loads an ABI-independent N-API prebuild, so after `postinstall`
  (`electron-builder install-app-deps`) tests still use a real `new Database(':memory:')`.
- Renderer tests: `vi.stubGlobal('api', makeApiMock(vi.fn()))` and the query helpers in
  `src/renderer/src/test/rendererTestUtils.ts`.
- `*.integration.test.ts` in `src/main/transfer/` use `startMockFtpServer`
  (`src/main/transfer/__fixtures__/mockFtpServer.ts`), a loopback server with only USER, PASS,
  FEAT, TYPE, STRU, OPTS, NOOP, PWD, SIZE, REST, PASV, RETR, STOR, QUIT and AUTH TLS/PBSZ/PROT (with
  `tls: true`). EPSV gets 500, anything else 502: no LIST/MLSD, CWD, MKD, DELE, RNFR/RNTO. RETR and
  SIZE ignore the path and serve the one `file` buffer; STOR uploads land in `server.stored`.
- Each test carries `// covers: Test-N`, mapping 1:1 to a case in a `docs/handoff/*.md` spec.
  Numbers are global and specs reserve them before tests exist, so the next free number is one
  above `grep -rhoE 'Test-[0-9]+' src script docs | sort -t- -k2 -n | tail -1`.

## Handoff specs (`docs/handoff/*.md`, Korean)

- A spec is the single input for one feature or bug: task type (R0), decisions settled in R1
  (usually with the human; IDs like `D3`/`M7`), rejected alternatives, numbered test cases, code
  pointers, done criteria. Cases not in the list are out of scope; do not add, merge or
  reinterpret them.
- Order: write the listed tests first and see them fail (RED), then implement to GREEN, then verify
  in the real app (R3). Done criteria often require re-scoping `mutate` in `stryker.config.json` to
  the changed lines (`git diff --unified=0 -- <file> | grep '^@@'`) and passing its `break: 70`.

## Conventions

- Prettier: single quotes, no semicolons, width 100, no trailing commas; 2-space indent.
- ESLint requires explicit return types on TS functions (`(): void`, `Promise<IpcResult<T>>`) and
  forbids `any`.
- Comments are Korean in most files and English in some; match the file you edit.
- Commits: English Conventional Commit subject with scope (`feat(transfer): …`, `fix(menu): …`,
  `docs(handoff): …`) and a Korean prose body explaining what changed and why.

## i18n

- `src/renderer/src/i18n/locales/en.ts` is the source of truth: keys `area.meaning`, placeholders
  `{{name}}`, `{{count}}` only for plurals. Plurals are `key_one`/`key_other` (+ `_few`/`_many` in
  `ru.ts`). All UI text goes through `const t = useT()` (components) with the base key:
  `t('delete.confirmTitle', { count })`.
- A new key goes into `en.ts` and, translated, into all 10 other locale files. Each ends with
  `satisfies LocaleMessages`, so typecheck fails on a missing key (`_one` is optional);
  `i18n.test.ts` fails on placeholders that differ from English or a missing plural category.
- A new locale must be added to `LOCALES` and `MESSAGES` in `i18n/index.ts`.

## Gotchas

- Contract tests in `src/shared/` read repo files and pin them; if one fails, rethink the change,
  not the test. `releaseArtifacts.test.ts`: `electron-builder.yml` (`files` allow-list `out/**`,
  `resources/**`, `package.json`, repeated in mac/linux; `asarUnpack`; artifact names),
  `release.yml`, `package.ps1`. `runtimeStack.test.ts`: electron 43, better-sqlite3 13,
  sharp ≥ 0.35, electron-vite 5, postinstall order, setup scripts. `ciWorkflow.test.ts`: `ci.yml`.
- electron-vite bundles main and preload as CJS (`package.json` has no `"type"`).
  `externalizeDepsPlugin` externalizes only `dependencies`, which ship from `node_modules`;
  everything in `devDependencies` (React, zustand, UI libs) is bundled. The native modules
  (better-sqlite3, sharp, koffi) are in `dependencies`.
- `out/main/` holds only `index.js`; `src/main/db/migrations/*.sql` are not copied, so the app (dev
  and build) runs the inline fallback SQL in `database.ts`: change both. Migrations are additive;
  never delete the user's existing `cache.db`.
- koffi is Windows-only: `src/main/utils/sparseFile.ts` imports it lazily on win32, and
  `electron-builder.yml` excludes it from mac/linux packages. Do not import it at top level.
- `--devtools` (`src/shared/debug.ts`) is the only way to enable DevTools, in dev too.
  `--smoke-test` (`src/main/smokeTest.ts`) works only in a packaged app and needs
  `FTP_BROWSER_SMOKE_USER_DATA`; `npm run smoke:packaged` sets both.

---

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

