# Bareun Grammar Assistant for Obsidian

Obsidian 플러그인 버전의 **바른 한국어 문법 검사기 (BKGA)** 입니다.  
Bareun NLP Revision API를 이용해 Markdown 노트의 맞춤법·띄어쓰기·표준어·통계적 교정을 자동으로 분석하고 물결 밑줄로 표시합니다.

> ⚠️ **Bareun API 사용 고지**  
> - 이 플러그인은 Bareun 클라우드 API에 의존합니다.  
> - 사용자는 [bareun.ai](https://bareun.ai/home)에서 **직접 API 키를 발급**해 설정 탭에 입력해야 합니다.  
> - Bareun의 최신 이용약관, 요금 정책, 사용 한도 등을 반드시 준수해 주세요.  
> - API 키를 소스나 릴리스에 포함하지 마세요. 각 사용자가 자신의 키를 입력해야 합니다.

## 주요 기능
- Markdown 편집기에서 자동 분석 (기본 디바운스 1200ms + 파일별 쿨다운 5초)
- 맞춤법/띄어쓰기/표준어/통계/기타 카테고리별 물결 밑줄 및 호버 툴팁, 색상 범례
- 상태바에서 분석 상태/오류 수 표시, 클릭 시 Issues 패널 열기
- Issues 패널: 현재 노트 문제 목록, 카테고리별 토글/리셋, 위치·원문·제안·즉시 적용 버튼, 항목 클릭 시 커서 이동, “사전에 추가” 바로가기
- 명령 팔레트: “BKGA: 현재 노트 분석”, “BKGA: Show BKGA issues panel”, “사용자 사전 동기화/선택 추가/단어 삭제/패널 열기”
- 설정 탭에서 Bareun API 키, 엔드포인트, 분석 경로 glob, 영어 무시, 디바운스/쿨다운, 자동/수동 분석 모드, 사용자 사전 사용 여부/엔드포인트/도메인, 사전에 있는 단어 숨김 여부를 조정
- 사용자 사전(옵션): 패널에서 상태/도메인/총 단어·최근 동기화 확인, 카테고리별 목록/삭제, “빠른 추가” 입력(현재 선택 자동 프리필) · “선택 추가”, Issues/호버에서 직접 추가
- Bareun API 미사용/오류 시 로컬 휴리스틱(여분 공백, 줄 끝 공백)으로 폴백

## 사용법 요약
1) API 키/도메인 설정  
   - Settings → Bareun Korean Grammar Assistant → API Key 입력.  
   - Custom dictionary → Enable + Domain 설정(필수), Endpoint는 기본값 사용 가능.

2) 자동/수동 분석  
   - 기본은 자동(realtime). 수동으로 바꾸면 명령 팔레트 “Run grammar assistant on current note”로 실행.

3) 문제 확인/수정  
   - 밑줄에 마우스를 올리면 호버 카드(기존/제안, 사전 추가 버튼).  
   - 사이드바 Issues 패널: 문제 목록 클릭 → 해당 위치로 이동, “적용”으로 제안 반영, “사전에 추가”로 곧바로 사용자 사전에 등록.

4) 사용자 사전 추가/관리  
   - 패널 “빠른 추가”: 입력 후 카테고리 선택 → 추가(현재 편집기 선택어가 있으면 자동 채움).  
   - 패널 “선택 추가”: 열려 있는 노트에서 선택한 텍스트를 바로 모달로 띄워 추가.  
   - 본문/호버/Issues에서 “사전에 추가” 버튼 → 모달에서 단어를 다듬고 카테고리 선택 후 저장.  
   - 패널 목록에서 “삭제”, 상단 “동기화”로 Bareun에 반영.  
   - 설정의 “Hide issues present in custom dictionary” 토글로 사전에 있는 단어를 밑줄/목록에서 숨기거나 다시 표시.

5) 카테고리 가이드  
   - 고유명사(np_set), 복합명사(cp_set), 복합명사 분리(cp_caret_set, `^` 포함), 동사(vv_set), 형용사(va_set).

## 수동 설치
1. `main.js`, `main.js.map`, `manifest.json`, `styles.css` 네 파일을 다운로드합니다.  
   (GitHub Releases에서 제공할 예정이며, zip으로 묶을 때도 **해당 파일들을 개별 파일로 제공**해야 합니다.)
2. 사용 중인 Vault의 `.obsidian/plugins/bareun-grammar-assistant/` 폴더에 위 네 파일을 넣습니다.
3. Obsidian → Settings → Community plugins → Installed plugins에서 “Bareun Grammar Assistant”를 활성화합니다.
4. Settings → Bareun Korean Grammar Assistant 탭에서 Bareun API 키를 입력하고 필요한 옵션을 조정합니다.

> 공식 커뮤니티 스토어 등재 전에는 [BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat)를 통해 깃허브 레포 URL을 등록하거나, 위 수동 설치 절차를 안내하면 됩니다.

## 개발 및 빌드
```bash
cd obsidian-plugin
npm install
npm run lint   # eslint-plugin-obsidianmd 기준으로 전체 검증
npm run build
```

- `npm run build` 후 생성되는 `main.js`, `main.js.map`을 릴리스에 포함하세요.
- `node_modules` 디렉터리는 릴리스에 포함하지 않습니다.
- Obsidian에 로드할 때 `manifest.json`, `main.js`, `main.js.map`, `styles.css` 네 파일이 필요합니다.
- 릴리스 전에는 `npm run lint`로 ESLint 전체 검증을 항상 수행하세요.

## 라이선스 & 출처
- 코드 전체는 MIT License 하에 배포됩니다 (`LICENSE` 참고, © 2025 Kwonhee Lee · idencosmos · Gurumii Lab).
- VS Code 버전의 [smart-korean-grammar-assistant](https://github.com/Hun-Bot2/smart-korean-grammar-assistant) 프로젝트를 참고/포함하여 Obsidian API에 맞게 재작성했습니다.  
  - 원본 저작권: © 2025 Hun-Bot2 (MIT), 조건에 따라 저작권/라이선스 고지를 유지합니다.
- Bareun API 및 서비스 정책은 Bareun에 귀속되며, 해당 약관을 따르는 것은 사용자의 책임입니다.

## 릴리스 & 공식 등록 가이드
1. `npm version patch|minor|major` 명령으로 버전을 올리고 Git 태그를 생성합니다.  
2. GitHub Releases에서 `manifest.json`, `main.js`, `main.js.map`, `styles.css`를 개별 첨부한 릴리스를 발행합니다.  
3. Obsidian 공식 커뮤니티 등록 시 `obsidianmd/obsidian-releases` 레포에 PR을 보내 `community-plugins.json`에 플러그인을 추가하고, PR 템플릿 체크리스트를 모두 충족하세요.

사용자에게 충분한 Bareun 정책 안내를 제공하고, 자신의 Bareun 계정으로 발급받은 API 키만 사용하도록 반드시 명시해 주세요.
