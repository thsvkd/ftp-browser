# 핸드오프: 1차 런타임 스택 업그레이드 (Electron 43 + better-sqlite3 13)

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 재해석하지 말 것.

작업 유형(R0): **기능(feature)**. R1→R4 전체 워크플로우를 수행한다.

---

## 1. 문제 정의

`./script/run.sh`가 `error during start dev server and electron app: Error: Electron uninstall`로 죽었다.

조사로 확인된 인과:

1. 작업 트리에서 `electron`이 커밋된 `^39.5.1`에서 `^43.4.0`으로 올라가 있었다.
2. Electron 43 npm 패키지에는 `scripts.postinstall`이 없다. `npm install`은 패키지만 깔고 `path.txt` / `dist/Electron.app`을 만들지 않는다.
3. `electron-vite@5.0.0`의 `getElectronPath`는 `require('electron')`으로 다운로드를 트리거하지 않는다. `path.txt`가 없으면 바로 `Error: Electron uninstall`을 throw한다.
4. 바이너리만 받아도 끝이 아니다. `better-sqlite3@12.6.2`는 Electron 43 V8 헤더에서 컴파일 실패한다(`SetNativeDataProperty` 모호, `External::Value` 태그 필수). ABI도 140 vs 148로 어긋난다.
5. `script/setup.sh`는 `node_modules`가 있으면 `npm install`을 스킵하고, 네이티브 검사는 `better_sqlite3.node` **파일 존재**만 본다. 바이너리 없는 electron과 ABI 틀린 `.node`를 모두 통과시킨다.

전체 패키지 최신화는 위험 축이 세 갈래라 **한 작업으로 하지 않기로** 합의했다. 이번 문서는 **1차(런타임 스택)** 만의 SSoT다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정 | 근거 |
| --- | --- | --- |
| D1  | 업그레이드를 **축으로 나눈다.** 1차는 런타임만 | 네이티브가 안 뜨면 UI 메이저 검증이 불가능. 직전 장애가 정확히 이 축 |
| D2  | 1차 패키지: `electron@^43.4.0`, `better-sqlite3@^13.0.3`, `sharp@^0.35.3`(이미 반영) | 43이 목표. 12.6.2는 43에서 컴파일 실패 |
| D3  | `better-sqlite3`는 **13.0.3 N-API** | npm 12 최신은 `12.11.1`. GitHub `12.11.2`(43 prebuild)는 레지스트리에 없음. 13은 N-API라 Electron ABI에 다시 묶이지 않음 |
| D4  | 앱이 쓰는 sqlite API만 유지: `new Database` / `pragma` / `exec` / `prepare` / `run` / `get`. `db.explain()` 등 13 신규 API는 **쓰지 않는다** | 호출부가 이 집합뿐 |
| D5  | Electron 바이너리 설치는 **`package.json` postinstall + `setup.sh`/`setup.ps1` 둘 다** | `npm ci`와 `run.sh → setup` 그리고 `node_modules` 스킵 분기를 모두 커버 |
| D6  | postinstall 순서: **먼저** `node node_modules/electron/install.js`, **그다음** `electron-builder install-app-deps` | 바이너리가 있어야 rebuild 대상 Electron 버전이 맞다 |
| D7  | setup은 `node_modules`가 있어도 `electron/path.txt`가 없으면 `install.js`를 실행한다 | 직전 장애의 재발 조건 |
| D8  | 기존 `userData/cache.db`는 **그대로 연다.** unlink/rm 없음. 안 열리면 조용히 삭제하지 않고 실패가 보이게 | 서버 목록·썸네일 인덱스를 업그레이드가 지우면 안 됨 |
| D9  | `electron-vite`는 **5.x 유지** (6.0.0-beta 금지) | 5의 peer는 Vite 5–7. Vite 8은 3차 축 |
| D10 | 1차에 넣지 않음: `lucide-react` 1, `sonner` 2, `react-resizable-panels` 4, `basic-ftp` 6, `tailwindcss` 4, `vite` 8, `typescript` 7, `eslint` 10, `stryker` 10, `@vitejs/plugin-react` 6 | 2차(앱 API)·3차(툴체인/CSS) |
| D11 | 계약 테스트는 기존 [`releaseArtifacts.test.ts`](../../src/shared/releaseArtifacts.test.ts)처럼 **레포 파일을 읽어 단언**한다. 새 YAML/스크립트 파서 패키지를 넣지 않는다 | 기존 패턴. 패키지 추가 승인 범위를 열지 않음 |
| D12 | Test-195~197은 **진짜 `better-sqlite3` 13**을 쓴다. `CacheManager.test.ts`처럼 sqlite를 목하지 않는다. `electron`은 `app.getPath`만 목한다 | "13에서 우리 호출이 된다"를 목으로 증명할 수 없음 |
| D13 | `initDatabase`의 모듈 싱글톤(`let db`)은 동작 변경 없이 테스트한다. 필요하면 `vi.resetModules()`로 모듈을 다시 올린다. 새 공개 API를  ent추출하는 것은 테스트가 RED가 되기 위한 최소일 때만 | 기존 패턴 유지 |
| D14 | Node `engines`(`^22.22.2 \|\| ^24.15.0`)와 CI Node 24.15.0은 **1차에서 바꾸지 않는다** | 이번 장애와 무관. 로컬 22.21.1 EBADENGINE은 별건 |
| D15 | 2차·3차 업그레이드는 이 문서의 완료 조건이 아니다. 별도 R1을 연다 | D1 |

---

## 3. 기각한 대안

- **모든 패키지를 npm `latest`로 한 번에** — Vite 8은 electron-vite 6-beta, Tailwind 4는 CSS 파이프라인 교체, TS 7은 툴체인. 기각(D1·D10).
- **툴체인이 받는 최신을 한 번에** — 1차에 UI 메이저까지 섞이면 실패 원인이 갈린다. 기각(D1).
- **런타임만 하고 setup/postinstall은 손대지 않음** — 43은 재발한다. 기각(D5).
- **setup만 고치거나 postinstall만 고침** — `npm ci`와 `node_modules` 스킵 분기를 각각 놓친다. 기각(D5).
- **`better-sqlite3@12.11.1` 유지** — npm 12줄에 43 prebuild가 없고, 12.6.2는 43 헤더에서 컴파일 실패가 실측됐다. 기각(D3).
- **캐시 DB 백업 파일 생성** — 복구 UI 없이 구현만 커진다. 기각(D8).
- **캐시 DB 폐기 후 재생성** — 저장된 FTP 서버 목록이 사라진다. 기각(D8).
- **electron-vite 6-beta + Vite 8을 1차에 포함** — 베타 툴체인. 기각(D9).
- **setup 검사를 순수 함수로 추출해 Test-N을 늘림** — 인간이 계약 테스트(186~194) + 동작 테스트(195~198)로 충분하다고 닫았다.

---

## 4. 관련 코드 포인터

| 파일 | 역할 |
| --- | --- |
| [`package.json`](../../package.json) | `electron` `^39.5.1` → `^43.4.0`, `better-sqlite3` `^12.6.2` → `^13.0.3`, `sharp`는 이미 `^0.35.3`. `postinstall`은 현재 `electron-builder install-app-deps`만 |
| [`package-lock.json`](../../package-lock.json) | 위와 함께 갱신 |
| [`script/setup.sh`](../../script/setup.sh) | 42–55행: `node_modules` 있으면 npm install 스킵. 57–75행: `better_sqlite3.node` 존재 + `require('sharp')`만 검사. **electron `path.txt` 검사 없음** |
| [`script/setup.ps1`](../../script/setup.ps1) | 동일 구조. 65–84행 네이티브 검사 |
| [`script/run.sh`](../../script/run.sh) | setup `--no-build` 후 `npm run dev` |
| [`src/main/db/database.ts`](../../src/main/db/database.ts) | `app.getPath('userData')/cache.db`를 연다. unlink/rm 없음. `pragma`/`exec`/추가 마이그레이션 |
| [`src/main/thumbnail/CacheManager.ts`](../../src/main/thumbnail/CacheManager.ts) 외 | `prepare`/`get`/`run` 사용처. 1차에서 API를 바꾸지 않음 |
| [`src/shared/releaseArtifacts.test.ts`](../../src/shared/releaseArtifacts.test.ts) | 레포 파일 계약 테스트 패턴. Test-186~194는 이 스타일. `covers: Test-185`는 jsdom Node pin |
| [`src/main/thumbnail/CacheManager.test.ts`](../../src/main/thumbnail/CacheManager.test.ts) | sqlite를 목하는 **반례**. Test-195~197은 이렇게 쓰지 말 것 |
| [`src/shared/debug.test.ts`](../../src/shared/debug.test.ts) | `covers: Test-N` 태그 레퍼런스 |
| [`src/main/debug/devtools.test.ts`](../../src/main/debug/devtools.test.ts) | `vi.mock('electron')` 최소 목 선례 |
| [`.github/workflows/release.yml`](../../.github/workflows/release.yml) | `npm ci` → 우리 postinstall. 워크플로 자체는 1차에서 수정하지 않음(D14) |

신규 파일은 테스트가 필요하다고 판단한 위치에만 둔다. 계약 테스트는 `src/shared/` 또는 기존 `releaseArtifacts.test.ts`에 붙이는 쪽이 이 레포 패턴이다. sqlite 실사용 테스트는 `src/main/db/` 옆이 자연스럽다.

---

## 5. 테스트 케이스 리스트 (완료의 정의)

`Test-186`부터 신규. **기존 최대 번호는 `Test-185`** (`releaseArtifacts.test.ts`의 jsdom Node pin).
R1 초안에서 184로 적은 것은 오산이다. 의미는 그대로이고 번호만 한 칸 민다.

각 테스트 코드에 `covers: Test-N` 태그를 단다. 새 케이스를 추가·재해석하지 않는다.

### A. 의존성 계약

- **Test-186** — `package.json` `devDependencies.electron`의 메이저 버전이 43이다.
- **Test-187** — `package.json` `dependencies.better-sqlite3`의 메이저 버전이 13이다.
- **Test-188** — `package.json` `dependencies.sharp`의 메이저가 0이고 minor가 35 이상이다.
- **Test-189** — `package.json` `devDependencies.electron-vite`의 메이저가 5이다.
- **Test-190** — `package.json` `scripts.postinstall`이 `node_modules/electron/install.js`(또는 동등한 `node …/electron/install.js`)를 **먼저** 실행하고, 그다음 `electron-builder install-app-deps`를 실행한다. 한쪽만 있으면 실패.

버전 문자열 파싱: `^43.4.0` / `43.4.0` / `~43.4.0`은 메이저 43으로 본다. `>=43`처럼 상한이 없는  comparators만으로 메이저를 단정하지 말고, **명시된 첫 숫자 구간**의 major를 읽는다.

### B. setup 스크립트 계약

- **Test-191** — `script/setup.sh`는 `node_modules` 디렉터리가 존재해도 `node_modules/electron/path.txt`가 없으면 `electron/install.js`를 실행하는 분기가 있다.
- **Test-192** — `script/setup.ps1`도 동일하다.
- **Test-193** — `script/setup.sh`의 기존 분기( `better-sqlite3/build/Release/better_sqlite3.node` 부재 → `electron-builder install-app-deps` )가 그대로 있다.
- **Test-194** — `script/setup.ps1`도 동일하다.

주의: 주석에 `path.txt`만 있고 실행이 없으면 RED여야 한다. `install.js` 문자열이 postinstall 설명 주석에만 있어도 RED여야 한다.

### C. better-sqlite3 13 실사용 (목 금지)

- **Test-195** — 임시 파일(또는 `:memory:`) DB에서 다음이 예외 없이 성공한다: `pragma('journal_mode = WAL')`, `exec`로 테이블 생성, `prepare` + `run` insert, `prepare` + `get` select. 사용하는 패키지는 설치된 `better-sqlite3`다.
- **Test-196** — `initDatabase`가 여는 경로는 `path.join(app.getPath('userData'), 'cache.db')`이고, 그 함수(및 같은 모듈)가 `cache.db`를 `unlink`/`rm`/`rmSync`/`unlinkSync` 하지 않는다. 동작 검증: 임시 `userData`에 기존 파일을 두고 `initDatabase()` 호출 뒤 파일이 남아 있다.
- **Test-197** — 현재 스키마(`servers`, `thumbnails` 테이블)가 들어 있는 기존 `cache.db`를 `initDatabase`가 열고, 두 테이블과 미리 넣은 행이 남아 있다.

Test-196·197은 `vi.mock('electron')`으로 `app.getPath`만 임시 디렉터리를 반환하게 한다. `better-sqlite3`와 `fs`는 목하지 않는다. 모듈 싱글톤은 `vi.resetModules()`로 격리한다.

### D. 회귀

- **Test-198** — 기존 vitest 스위트가 GREEN이다. 이 케이스를 위한 새 단언 파일을 만들지 않는다. R2/R3에서 `npm test` 실행 출력이 증거다.

### 1차에서 명시적으로 제외

`lucide-react` 1, `sonner` 2, `react-resizable-panels` 4, `basic-ftp` 6, `tailwindcss` 4, `vite` 8, `typescript` 7, `eslint` 10, `stryker` 10, `electron-vite` 6-beta, Node engines 변경, CI Node 버전 변경.

### R3 실측 (테스트 코드 밖, 증거만)

- `./script/run.sh`(또는 `npm run dev`)가 `Electron uninstall` 없이 기동한다.
- main이 `better-sqlite3` NODE_MODULE_VERSION / 컴파일 오류 없이 IPC를 등록한다.

---

## 6. R2에게

1. 이 문서의 Test-186~197만 테스트 코드로 옮긴다. Test-198은 스위트 실행 증거.
   `covers: Test-185`는 `releaseArtifacts.test.ts`의 jsdom Node pin이 이미 쓴다. 재사용 금지.
2. 각 테스트에 `covers: Test-N` 태그를 단다.
3. 새 케이스를 추가·재해석하지 않는다.
4. 구현을 쓰지 않는다. 구현 전에 RED여야 한다(현재 package.json은 electron 39 / better-sqlite3 12, postinstall에 install.js 없음, setup에 path.txt 검사 없음).
5. 테스트 작성자 ≠ 구현자.
