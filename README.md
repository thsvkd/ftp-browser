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

Claude Code, Codex, Gemini CLI 같은 AI 에이전트가 이 앱을 대신 조작할 수 있습니다. 저장된 서버 연결, 폴더 탐색, 다운로드·업로드, 이름 변경, 삭제를 도구로 열고, 에이전트가 한 일은 앱 창에 그대로 보입니다. 기본으로 꺼져 있습니다.

1. 설정의 **Agent access (MCP)**에서 **Enable MCP server**를 켭니다. 서버는 이 컴퓨터(`http://127.0.0.1:47821/mcp`)에서만 열리고 접속 토큰을 요구합니다.
2. **Command-line tool**의 **Install**로 `ftpb` 명령을 설치합니다(macOS·Linux는 `~/.local/bin/ftpb`, Windows는 사용자 폴더의 `ftpb.cmd`와 사용자 PATH). 그 폴더가 PATH에 없으면 화면에 나오는 한 줄을 실행합니다.
3. **Connect an agent**에서 에이전트를 고르고 **Copy setup**으로 복사한 설정을 그 에이전트에 넣습니다. 터미널에서는 `ftpb setup <client>`가 같은 설정을 보여 줍니다(`ftpb setup --list`로 목록). 대부분의 설정은 토큰을 담지 않고 실행할 때 `ftpb`나 토큰 파일에서 읽습니다.
4. 셸을 쓰는 에이전트를 위해 **Agent skill**을 설치하면 에이전트가 `ftpb` 사용법을 스스로 찾습니다(`ftpb skill install`과 같음).

`ftpb`는 앱의 MCP 서버에 붙는 얇은 클라이언트라 앱이 꺼져 있으면 동작하지 않습니다. `ftpb tools`로 도구와 위험 등급을, `ftpb <도구> --help`로 인자를 보고 `ftpb list-directory --path /photos`처럼 실행합니다. 파이프로 받으면 JSON을 출력하고, 종료 코드는 0 성공, 1 도구 오류, 2 사용법 오류, 3 앱이 거부, 4 앱 미실행·접근 꺼짐·토큰 거부입니다. Claude Desktop처럼 로컬 HTTP에 직접 붙지 못하는 클라이언트는 `ftpb mcp-stdio` 브리지를 씁니다.

원격 파일 이름처럼 신뢰할 수 없는 문자열은 명령줄 인자가 아니라 stdin의 JSON으로 넘깁니다. `ftpb call <도구> --args -`는 인자 전체를 stdin에서 JSON 객체 하나로 읽습니다(`ftpb call delete --args - < args.json`). 특히 Windows에서는 `ftpb.cmd`를 cmd.exe가 다시 해석하므로 따옴표·`&`·`|`·`%`가 든 인자가 명령으로 바뀔 수 있습니다. 설치되는 에이전트 스킬도 이렇게 안내합니다.

모든 도구는 R(읽기)·W(데이터 손실 없는 변경)·D(삭제)·X(업로드)·C(서버 설정) 중 한 등급이고, **Permissions**에서 등급마다 Allow·Ask·Block을 고릅니다. 기본값은 D·X·C가 Ask라서 에이전트가 삭제·업로드·서버 설정을 하려 하면 앱이 확인 창을 띄우며, 에이전트가 어떤 클라이언트를 쓰든 이 결정은 앱이 내립니다.

**Regenerate token**을 누르면 이전 토큰은 바로 거부됩니다. 토큰을 직접 담는 설정(Gemini CLI, Qwen Code, VS Code에 입력한 값)만 다시 넣으면 됩니다.

## 자동 검증

Pull request와 `main` 브랜치 변경은 GitHub Actions에서 Windows x64, Linux x64, macOS arm64 및 Intel로 각각 테스트합니다. 각 환경은 unpacked 앱을 패키징한 뒤 실제 Electron 프로세스를 실행해 renderer와 네이티브 모듈이 정상적으로 시작되는지 확인합니다. 태그 릴리스는 이 검증이 모두 통과한 뒤 같은 OS·아키텍처 조합의 설치 패키지를 각 네이티브 러너에서 만들고 하나의 GitHub Release에 함께 게시합니다.

## 개발

- `.\script\setup.ps1` — 의존성 + 프로덕션 빌드 (`--no-build`면 타입체크만)
- `.\script\run.ps1` — dev 모드 (`--devtools`로 개발자 도구)
- `.\script\test.ps1` — 테스트
- `.\script\lint.ps1` — 린트
- `.\script\package.ps1` — Windows x64 설치기·포터블 로컬 빌드
