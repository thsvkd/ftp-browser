# FTP Browser

FTP 서버 브라우저. 이미지 썸네일 미리보기를 지원합니다.

## Windows 설치 파일

릴리스는 [GitHub Releases](https://github.com/thsvkd/ftp-browser/releases)에 올라갑니다. 태그 `vX.Y.Z`가 `package.json` 버전과 같을 때만 CI가 빌드합니다.

| 파일 | 용도 |
| --- | --- |
| `ftp-browser-{version}-setup.exe` | 사용자 폴더에 설치 (관리자 권한 없음). 바탕화면 바로가기를 만듭니다. |
| `ftp-browser-{version}-portable.exe` | 설치 없이 실행. |

코드 서명이 없으므로 Windows SmartScreen이 막을 수 있습니다. **추가 정보 → 실행**을 누르면 됩니다.

macOS / Linux 설치 파일은 아직 배포하지 않습니다.

## 개발

- `.\script\setup.ps1` — 의존성 + 프로덕션 빌드 (`--no-build`면 타입체크만)
- `.\script\run.ps1` — dev 모드 (`--devtools`로 개발자 도구)
- `.\script\test.ps1` — 테스트
- `.\script\lint.ps1` — 린트
- `.\script\package.ps1` — Windows x64 설치기·포터블 로컬 빌드
