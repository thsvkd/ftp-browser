# FTP Browser

FTP 서버 브라우저. 이미지 썸네일 미리보기를 지원합니다.

## 릴리스 파일

릴리스는 [GitHub Releases](https://github.com/thsvkd/ftp-browser/releases)에 올라갑니다. 태그 `vX.Y.Z`가 `package.json` 버전과 같을 때만 CI가 빌드합니다.

| 파일                                       | 용도                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `ftp-browser-{version}-setup.exe`          | 사용자 폴더에 설치 (관리자 권한 없음). 바탕화면 바로가기를 만듭니다. |
| `ftp-browser-{version}-portable.exe`       | 설치 없이 실행.                                                      |
| `ftp-browser-{version}-mac-arm64.dmg`      | Apple Silicon Mac용 설치 이미지.                                     |
| `ftp-browser-{version}-mac-x64.dmg`        | Intel Mac용 설치 이미지.                                             |
| `ftp-browser-{version}-mac-{arch}.zip`     | 해당 Mac 아키텍처용 압축 앱.                                         |
| `ftp-browser-{version}-linux-x64.AppImage` | 대부분의 x64 Linux 배포판에서 설치 없이 실행.                        |
| `ftp-browser-{version}-linux-x64.deb`      | Debian, Ubuntu, Mint 계열용 패키지.                                  |

아직 코드 서명을 적용하지 않았으므로 Windows SmartScreen이나 macOS Gatekeeper가 실행을 막을 수 있습니다. 출처와 체크섬을 확인한 뒤 운영체제의 보안 설정에서 실행을 허용해야 합니다.

## 자동 검증

Pull request와 `main` 브랜치 변경은 GitHub Actions에서 Windows x64, Linux x64, macOS arm64 및 Intel로 각각 테스트합니다. 각 환경은 unpacked 앱을 패키징한 뒤 실제 Electron 프로세스를 실행해 renderer와 네이티브 모듈이 정상적으로 시작되는지 확인합니다. 태그 릴리스는 이 검증이 모두 통과한 뒤 같은 OS·아키텍처 조합의 설치 패키지를 각 네이티브 러너에서 만들고 하나의 GitHub Release에 함께 게시합니다.

## 개발

- `.\script\setup.ps1` — 의존성 + 프로덕션 빌드 (`--no-build`면 타입체크만)
- `.\script\run.ps1` — dev 모드 (`--devtools`로 개발자 도구)
- `.\script\test.ps1` — 테스트
- `.\script\lint.ps1` — 린트
- `.\script\package.ps1` — Windows x64 설치기·포터블 로컬 빌드
