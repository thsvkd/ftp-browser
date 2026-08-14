# 핸드오프: Windows 바이너리 GitHub Releases 배포 (1차)

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 재해석하지 말 것.

작업 유형(R0): **기능(feature)**.

---

## 1. 문제 정의

이 앱은 Electron + electron-builder인데, **설치 파일을 만드는 CI와 배포 채널이 없다.**
`package.json`에 `build:win` / `build:mac` / `build:linux`가 있고
[`electron-builder.yml`](../../electron-builder.yml)에 NSIS·DMG·AppImage 설정이 있으나:

- `.github/workflows/`가 없다.
- `publish.url`이 `https://example.com/auto-updates` 플레이스홀더다.
- README가 없다.
- `electron-updater` 의존성이 없고 앱 코드에 autoUpdater 호출도 없다.
- `sharp`·`better-sqlite3`가 네이티브 모듈이라 **호스트 OS에서만** 패키징할 수 있다.

사용자는 소스 클론 없이 Windows에서 앱을 설치·실행할 수 있어야 한다.

---

## 2. 핵심 결정 (R1에서 인간이 확정 + 거절 문항은 권장값)

| #   | 결정 | 근거 |
| --- | --- | --- |
| D1  | 채널은 **GitHub Releases**. 스토어·자체 호스팅 없음 | origin이 이미 `thsvkd/ftp-browser`. 추가 인프라 없음 |
| D2  | 1차 산출물은 **Windows x64 NSIS + portable exe**만 | 사용자가 이 슬라이스를 선택. mac/linux·Windows arm64는 다음 |
| D3  | NSIS는 **one-click, per-user, 관리자 승격 없음** | 회사/공용 PC에서 UAC 없이 설치. `perMachine: false`, `allowElevation: false` |
| D4  | 릴리스 자르기: **`vX.Y.Z` 태그 === `package.json` version** | 태그와 파일명 버전이 어긋나면 안 된다. `workflow_dispatch` 없음 |
| D5  | 태그 규칙: `GITHUB_REF_NAME === 'v' + version` (접두사 `v` 하나 + 완전 일치) | `1.2.3`(접두사 없음), `v1.2.3` vs `1.2.4`, `v1.2.3-beta.1` vs `1.2.3` 전부 거부 |
| D6  | 잡 성공 시 Release를 **즉시 공개**(draft 아님). 실패하면 Release를 만들지 않는다 | 거절된 문항의 권장값 |
| D7  | CI는 `windows-latest` 하나. `npm test` 후에 `electron-builder --win --publish never` | 네이티브 모듈. example.com으로 publish 금지 |
| D8  | Release 첨부는 `*-setup.exe`와 `*-portable.exe`만. **`.blockmap` 제외** | 자동 업데이트 없음. blockmap은 차분 업데이트용 |
| D9  | 로컬 패키징은 `script/package.ps1`이 `npm run build:win`을 호출 | 기존 `setup`/`run`/`test`/`lint` 패턴 |
| D10 | `electron-builder.yml`의 generic `example.com` publish를 **제거** | 실수 `--publish always`가 가짜 URL로 나가지 않게 |
| D11 | mac/linux 빌더 블록은 **지우지 않는다**. 카메라/마이크 entitlements도 이번 범위 밖 | 1차는 Windows. 다른 플랫폼 설정 정비는 별 슬라이스 |
| D12 | 자동 업데이트(`electron-updater`)는 **범위 밖** | 사용자가 Windows만 선택. updater는 3차 |
| D13 | 코드 사이닝/공증은 **범위 밖**. README에 SmartScreen 우회를 적는다 | 인증서 없음 |
| D14 | 태그 푸시는 **구현 완료 후 인간이 한다**. CI/스크립트가 태그를 만들지 않는다 | 승인 전 push 금지(AGENTS.md)와 동일 취지 |
| D15 | 태그↔버전 판정은 순수 함수 `releaseTagMatchesVersion(tagName, version)` | 기존 `src/shared` 순수 함수 패턴. CI와 단위 테스트가 같은 함수를 쓴다 |

---

## 3. 기각한 대안

- **3플랫폼 unsigned 한 번에** — 사용자가 Windows만 선택. 기각(D2).
- **Windows + electron-updater** — 범위가 커지고 사이닝 없는 업데이트는 신뢰 문제가 있다. 기각(D12).
- **workflow_dispatch로 재빌드** — 태그와 버전의 단일 입구가 깨진다. 기각(D4).
- **태그와 package.json을 대조하지 않음** — 파일명 버전이 거짓이 된다. 기각(D4).
- **per-machine / 경로 선택 마법사** — 관리자 필요·설치 화면이 길다. 기각(D3).
- **x64 + arm64** — 러너·네이티브 모듈이 두 배. 기각(D2).
- **electron-builder github provider가 직접 업로드** — GH_TOKEN 권한·draft 동작이 도구에 묶인다. `--publish never` + `softprops/action-gh-release`가 첨부 glob을 테스트 가능하게 만든다(D7·D8).
- **로컬에서만 `npm run build:win`하고 손으로 업로드** — 네이티브 모듈·반복 배포에 약하다. 기각.
- **새 YAML 파서 의존성** — 계약 테스트는 파일을 읽어 필요한 키를 단언한다. 패키지 추가 승인 범위를 열지 않는다.

---

## 4. 관련 코드 포인터

| 파일 | 역할 |
| --- | --- |
| [`electron-builder.yml`](../../electron-builder.yml) | NSIS 이름·shortcut은 이미 있음. target에 portable 추가, per-user/no-elevation, arch x64, publish 제거 |
| [`package.json`](../../package.json) | `version`, `build:win` (`electron-builder --win`). 버전 숫자는 이 작업이 올리지 않음 |
| [`script/_common.ps1`](../../script/_common.ps1) | 새 `package.ps1`이 dot-source하는 헤더 |
| [`script/setup.ps1`](../../script/setup.ps1) | Node 20, `install-app-deps`. CI도 Node 20 |
| [`src/shared/debug.ts`](../../src/shared/debug.ts) | 순수 함수 + `*.test.ts` + `covers: Test-N` 패턴의 레퍼런스 |
| (신규) `src/shared/releaseTag.ts` | `releaseTagMatchesVersion` |
| (신규) `src/shared/releaseTag.test.ts` | A 그룹 |
| (신규) `electron-builder.yml.test.ts` 또는 `src/shared/releaseArtifacts.test.ts` | B·C·D 그룹. 워크플로·yml·ps1을 읽어 계약 단언 |
| (신규) `.github/workflows/release.yml` | 태그 트리거 Windows 릴리스 |
| (신규) `script/package.ps1` | 로컬 `npm run build:win` |
| (신규) `README.md` | 어느 파일을 받을지 + SmartScreen 안내. 테스트 케이스 없음(D13 문서) |

`build:win`은 이미 `electron-builder --win`이다. CI가 `--publish never`를 강제하려면
`npm run build:win -- --publish never` 또는 `electron-builder --win --publish never`를
워크플로에 명시한다. `package.json` 스크립트 자체를 바꿔 로컬 패키징까지 never로 고정해도 된다.

CI에서 `releaseTagMatchesVersion`을 호출하는 방법: Node 20에서 TS를 직접 실행하지 않는다.
워크플로는 `npx vitest run src/shared/releaseTag.test.ts`가 아니라, **같은 함수를 쓰는
작은 node 진입점**을 둔다. 권장: `package.json`의 `"check:release-tag"`가
`electron-vite`/빌드 없이 동작하도록 `src/shared/releaseTag.ts`를 순수 TS로 두고
테스트는 vitest가 임포트한다. CI 체크 스텝은 아래 중 **기존 스택만** 쓴다.

- `npx vitest run src/shared/releaseTag.test.ts`는 환경변수 없이 단위 테스트만 돌린다(불충분).
- 구현체는 `releaseTagMatchesVersion`을 export하고, 워크플로는
  `node -e`로 `package.json` version과 `GITHUB_REF_NAME`을 읽어
  **테스트와 동일한 규칙**(`tag === 'v' + version`)을 적용한다.

규칙을 두 곳에 적지 않으려면, `releaseTag.ts`에
`if (import.meta.url === ...)` 같은 이중 진입을 만들지 말고,
워크플로가 `npx vitest` 전체(`npm test`)를 돌린 뒤
체크 스텝에서 `node`로 `require`할 수 있는 **테스트가 커버하는 순수 함수와
한 줄 비교가 수학적으로 같음**을 Test-168~171이 고정하는 것으로 충분하다.
체크 스텝의 비교식은 `process.env.GITHUB_REF_NAME === 'v' + require('./package.json').version`
이다. 이 한 줄이 Test-168~171의 규칙과 같다.

---

## 5. 테스트 케이스 리스트 (확정)

`Test-168`부터 신규. **기존 최대 번호는 `Test-167`.**
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

실제 `electron-builder`로 exe를 만들어 실행하는 것은 단위 테스트 범위 밖이다.
그 검증은 CI 잡이 수행한다.

### A. `releaseTagMatchesVersion(tagName, version)` — `src/shared/releaseTag.ts`

- **Test-168** — `'v1.2.3'` + `'1.2.3'` → `true`
- **Test-169** — `'v1.2.3'` + `'1.2.4'` → `false`
- **Test-170** — `'1.2.3'` + `'1.2.3'` → `false` (`v` 접두사 필수)
- **Test-171** — `'v1.2.3-beta.1'` + `'1.2.3'` → `false` (접두사 `v` 하나를 제거한 나머지가 version과 완전 일치해야 함)

### B. `electron-builder.yml` 계약

- **Test-172** — `win` target은 `nsis`와 `portable`이고 그 둘뿐이다.
- **Test-173** — NSIS는 one-click(`oneClick`이 `true`이거나 키 생략 — electron-builder 기본이 true이므로
  **명시적으로 `oneClick: true`를 둘 것**), `perMachine: false`, `allowElevation: false`.
- **Test-174** — NSIS `artifactName`은 `${name}-${version}-setup.${ext}`
- **Test-175** — portable `artifactName`은 `${name}-${version}-portable.${ext}`
- **Test-176** — win arch는 `x64`만 (`ia32`/`arm64` 없음)
- **Test-177** — 파일 전체에 `example.com` 문자열이 없다.

### C. `.github/workflows/release.yml` 계약

- **Test-178** — 트리거는 `push.tags`의 `v*`뿐이고 `workflow_dispatch` 키가 없다.
- **Test-179** — `runs-on`은 `windows-latest`뿐이고 `macos-latest` / `ubuntu-latest`가 없다.
- **Test-180** — 패키징 스텝보다 앞에 테스트 스텝이 있다(`npm test` 또는 `.\script\test.ps1`).
- **Test-181** — 패키징 커맨드에 `--publish never`가 있다.
- **Test-182** — Release 생성 스텝이 draft를 켜지 않는다(`draft: true` 없음).
- **Test-183** — 첨부 glob에 `*setup*.exe`와 `*portable*.exe`가 있고 `.blockmap`이 없다.

### D. 로컬 스크립트

- **Test-184** — `script/package.ps1`이 `npm run build:win`을 호출한다.

---

## 6. 구현 시 함정

1. `electron-builder.yml`의 `publish`를 github provider로 바꾸면 `--publish never`를 빼먹는 순간
   토큰으로 Release가 두 번 만들어질 수 있다. **publish 블록을 삭제**하는 편이 D10과 맞다.
2. NSIS 기본값이 one-click·per-user라도 Test-173은 **명시적 키**를 요구한다. 키를 생략하면
   기본값 변경 시 조용히 per-machine이 될 수 있다.
3. `npm run build:win`은 `electron-builder --win`만 넘긴다. CI는 반드시 `--publish never`를
   뒤에 붙여야 한다(`npm run build:win -- --publish never`).
4. `softprops/action-gh-release`는 같은 태그를 다시 푸시하면 에셋을 갱신한다. 태그는 immutable로
   취급하고, 고치려면 새 버전을 올린다.
5. `package.json` version을 이 작업에서 올리지 않는다. 현재 `1.0.0`이면 첫 태그는 인간이 `v1.0.0`.
6. 워크플로 `permissions.contents: write`가 없으면 Release 생성이 403이다.
7. `npm ci`는 `postinstall` → `electron-builder install-app-deps`를 탄다. `npmRebuild: false`는
   그대로 둔다(이미 yml에 있음).
8. 기존 미커밋 파일(`useContextMenuStore*`, `context-menu-single-owner.md`, `package-lock.json`)은
   **이 작업이 건드리지 않는다.**
