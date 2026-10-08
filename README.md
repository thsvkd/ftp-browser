# FTP Browser

FTP 서버 브라우저. 이미지 썸네일 미리보기를 지원합니다.

## 릴리스 파일

릴리스는 [GitHub Releases](https://github.com/thsvkd/ftp-browser/releases)에 올라갑니다. 태그 `vX.Y.Z`가 `package.json` 버전과 같을 때만 CI가 빌드합니다.

| 파일                                          | 용도                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `ftp-browser-{version}-setup.exe`             | 사용자 폴더에 설치 (관리자 권한 없음). 바탕화면 바로가기를 만듭니다. |
| `ftp-browser-{version}-portable.exe`          | 설치 없이 실행.                                                      |
| `ftp-browser-{version}-mac-arm64.dmg`         | Apple Silicon Mac용 설치 이미지.                                     |
| `ftp-browser-{version}-mac-x64.dmg`           | Intel Mac용 설치 이미지.                                             |
| `ftp-browser-{version}-mac-{arch}.zip`        | 해당 Mac 아키텍처용 압축 앱.                                         |
| `ftp-browser-{version}-linux-x86_64.AppImage` | 대부분의 x64 Linux 배포판에서 설치 없이 실행.                        |
| `ftp-browser-{version}-linux-amd64.deb`       | Debian, Ubuntu, Mint 계열용 패키지.                                  |

아직 코드 서명을 적용하지 않았으므로 Windows SmartScreen이나 macOS Gatekeeper가 실행을 막을 수 있습니다. 출처와 체크섬을 확인한 뒤 운영체제의 보안 설정에서 실행을 허용해야 합니다.

## 업데이트

Windows 설치판은 앱을 시작할 때 새 버전을 확인합니다. 설정의 **Updates**에서 직접 확인하거나 다운로드한 뒤, **Restart and update**를 눌러 설치할 수 있습니다. 앱이 임의로 다운로드하거나 재시작하지는 않습니다.

포터블 Windows 실행 파일과 macOS·Linux 패키지는 자동 업데이트 대상이 아닙니다. 새 버전은 GitHub Releases에서 직접 내려받아 설치해야 합니다. 자동 업데이트 기능이 처음 포함된 버전도 이전 버전에서 한 번 수동 설치해야 이후 릴리스부터 자동 업데이트를 받을 수 있습니다.

## 에이전트 연동

Claude Code, Codex 같은 AI 에이전트가 이 앱을 도구로 쓸 수 있습니다. 저장된 서버 연결, 폴더 탐색, 이미지 미리보기, 다운로드·업로드, 이름 변경, 삭제를 할 수 있고, 에이전트가 한 일은 앱 창에 그대로 보입니다. 기본으로 꺼져 있습니다.

1. 설정의 **Agent access (MCP)**에서 **Enable MCP server**를 켭니다. 서버는 이 컴퓨터(`http://127.0.0.1:47821/mcp`)에서만 열리고 접속 토큰을 요구합니다.
2. MCP 클라이언트에 등록합니다. Claude Code는 **Copy Claude Code command**로 복사한 명령을 터미널에서 실행합니다. 다른 클라이언트도 같은 URL과 `Authorization: Bearer <토큰>` 헤더로 등록합니다.
3. 셸만 쓰는 에이전트는 **Copy CLI command**로 복사한 명령(앱에 든 `ftpb`를 앱 실행 파일로 돌립니다. Windows는 PowerShell 형식)에 `tools`, `<도구> --help`, `list-directory --path /photos`처럼 인자를 붙여 씁니다. `ftpb`는 앱이 실행 중이어야 동작하고, `--help`가 사용법·위험도·종료 코드(0 성공, 1 도구 오류, 2 사용법 오류, 4 앱 미실행·접근 꺼짐·토큰 거부)와 예제를 보여 줍니다.

각 도구 설명의 첫 줄은 위험도(`[RISK: read-only]`, `[RISK: changes state, no data loss]`, `[RISK: uploads local files to the server]`, `[RISK: DESTRUCTIVE — …]`)입니다. 앱은 실행 전에 묻지 않으니 업로드·삭제는 에이전트 도구의 승인 기능으로 확인하세요. 다운로드는 이미 있는 로컬 파일을 덮어쓰지 않고, 이름 변경도 덮어쓰지 않습니다.

`ftpb`의 출력은 항상 JSON입니다. `get-image-previews`가 받은 미리보기는 OS 임시 폴더의 `ftpb-previews`에 파일로 저장되고, 출력에는 base64 대신 그 경로(`savedTo`)가 나옵니다. 원격 파일 이름처럼 신뢰할 수 없는 문자열은 명령줄 인자가 아니라 stdin의 JSON으로 넘깁니다(`ftpb delete --args - < args.json`). 특히 Windows 셸은 따옴표·`&`·`|`·`%`가 든 인자를 다시 해석합니다.

**Regenerate token**을 누르면 이전 토큰은 바로 거부됩니다. MCP 클라이언트에는 새 명령으로 다시 등록합니다(`ftpb`는 토큰을 앱에서 읽습니다).

## 자동 검증

Pull request와 `main` 브랜치 변경은 GitHub Actions에서 Windows x64, Linux x64, macOS arm64 및 Intel로 각각 테스트합니다. 각 환경은 unpacked 앱을 패키징한 뒤 실제 Electron 프로세스를 실행해 renderer와 네이티브 모듈이 정상적으로 시작되는지 확인합니다. 태그 릴리스는 이 검증이 모두 통과한 뒤 같은 OS·아키텍처 조합의 설치 패키지를 각 네이티브 러너에서 만들고 하나의 GitHub Release에 함께 게시합니다.

## 개발

- `.\script\setup.ps1` — 의존성 + 프로덕션 빌드 (`--no-build`면 타입체크만)
- `.\script\run.ps1` — dev 모드 (`--devtools`로 개발자 도구)
- `.\script\test.ps1` — 테스트
- `.\script\lint.ps1` — 린트
- `.\script\package.ps1` — Windows x64 설치기·포터블 로컬 빌드
