# AI Agents Guide

이 문서는 AI 에이전트가 프로젝트를 이해하고 작업할 수 있도록 돕는 가이드입니다.

## 프로젝트 개요

DaleStudy 조직의 GitHub App(https://github.com/apps/dalestudy)

### 현재 구현된 기능

#### 1. PR Week 설정 자동 검사 (리트코드 스터디)

Fork PR에서도 작동하도록 GitHub Projects v2의 Week 필드를 조회하고, Week 설정이 누락된 PR에 자동으로 경고 댓글을 작성하며, Week 설정이 완료되면 경고 댓글을 자동으로 삭제한다.

- **대상 Repository**: https://github.com/DaleStudy/leetcode-study
- **트리거 방식**:
  - **실시간**: GitHub Organization Webhook (`projects_v2_item`, `pull_request` 이벤트)
  - **수동**: `POST /check-weeks` 엔드포인트 직접 호출

### 기술 스택

- **Runtime**: Cloudflare Workers
- **Language**: JavaScript (ES Modules)
- **Authentication**: GitHub App (JWT + Installation Token)
- **APIs**: GitHub REST API, GitHub GraphQL API

## 프로젝트 구조

```
~/work/github/
├── index.js           # Worker 메인 코드 (엔드포인트 라우팅)
├── wrangler.jsonc     # Cloudflare Workers 설정
├── .env               # 로컬 환경 변수 (커밋 제외)
├── .gitignore         # Git 제외 파일
├── handlers/          # 기능별 핸들러
│   ├── check-weeks.js # PR Week 설정 검사 (수동 호출용)
│   └── webhooks.js    # GitHub webhook 이벤트 처리
├── utils/             # 공통 유틸리티
│   ├── cors.js        # CORS 헤더 및 응답 유틸리티
│   ├── github.js      # GitHub 인증 및 API 유틸리티
│   └── webhook.js     # Webhook signature 검증
├── README.md          # 프로젝트 설명
├── DEPLOYMENT.md      # 배포 가이드
├── AGENTS.md          # 이 파일 (AI 에이전트 가이드)
├── CLAUDE.md          # Claude Code 참조 파일 (AGENTS.md로 리다이렉트)
└── *.pem              # GitHub App Private Keys (커밋 제외)
```

### 코드 구조 설명

- **index.js (32줄)**: 엔드포인트 라우팅만 담당. pathname별 핸들러 호출
- **handlers/**: 기능별 핸들러
  - `check-weeks.js`: PR Week 설정 검사, 댓글 작성/삭제
- **utils/**: 여러 핸들러에서 공통으로 사용하는 유틸리티
  - `cors.js`: CORS 헤더 관리 및 응답 생성 (`corsResponse`, `errorResponse`)
  - `github.js`: GitHub App 인증 (JWT, Installation Token), RSA 서명

### 새 기능 추가 시

1. 기능별 핸들러 파일 생성 (예: `handlers/new-feature.js`)
2. `index.js`에 pathname 라우팅 추가

```javascript
// handlers/new-feature.js 생성
export async function newFeature(request, env) {
  // 비즈니스 로직
  return corsResponse({ success: true });
}

// index.js에 라우팅 추가
import { newFeature } from './handlers/new-feature.js';

if (url.pathname === '/new-feature') {
  return newFeature(request, env);
}
```

## 주요 명령어

### 로컬 개발

```bash
# 로컬 개발 서버 실행 (포트 8787)
wrangler dev

# 로컬 테스트 (별도 터미널)
curl -X POST http://localhost:8787/check-weeks \
  -H "Content-Type: application/json" \
  -d '{"repo_owner": "DaleStudy", "repo_name": "leetcode-study"}'
```

### 배포

```bash
# Worker 배포
wrangler deploy

# Secrets 설정
wrangler secret put APP_ID        # GitHub App ID (숫자)
wrangler secret put PRIVATE_KEY   # GitHub App Private Key (PEM 전체)

# Secrets 확인
wrangler secret list

# 실시간 로그 확인
wrangler tail
```

### 프로덕션 테스트

```bash
# 배포된 Worker 테스트
curl -X POST https://github.dalestudy.com/check-weeks \
  -H "Content-Type: application/json" \
  -d '{"repo_owner": "DaleStudy", "repo_name": "leetcode-study"}'
```

## 핵심 기능

### 1. GitHub App 인증

인증 흐름:

1. RS256 알고리즘으로 JWT 생성 (Web Crypto API 사용)
2. JWT로 Installation ID 조회
3. Installation Token 발급 (10분 유효)
4. 모든 API 요청에 Installation Token 사용

인증 관련 함수:

- `generateGitHubAppToken()`: GitHub App Installation Token 발급 (전체 흐름 관리)
- `createJWT()`: RS256 JWT 생성 (GitHub App 인증용, 10분 유효)
- `importPrivateKey()`: PEM 형식 Private Key를 Web Crypto API용으로 변환 (PKCS8/PKCS1 모두 지원)
- `sign()`: RS256 서명 생성
- `base64UrlEncode()`: Base64 URL-safe 인코딩

### 2. API 엔드포인트 구조

현재 구현된 엔드포인트:

#### `POST /webhooks`

GitHub Organization webhook 수신용 엔드포인트

- **이벤트**: `projects_v2_item`, `pull_request`
- **실시간 처리**: Week 설정 변경 즉시 감지 및 댓글 작성/삭제

#### `POST /check-weeks`

모든 Open PR에서 Week 설정을 검사하고 자동으로 댓글 작성/삭제 (수동 호출용)

**Request:**

```json
{
  "repo_owner": "DaleStudy",
  "repo_name": "leetcode-study"
}
```

**Response:**

```json
{
  "success": true,
  "total_prs": 3,
  "checked": 3,
  "commented": 1,
  "deleted": 1,
  "results": [
    { "pr": 1970, "week": null, "commented": true },
    { "pr": 1969, "week": "Week 8", "commented": false, "deleted": true }
  ]
}
```

### 3. 워크플로우

1. Open PR 목록 조회 (GitHub REST API)
2. `maintenance` 라벨 있는 PR 스킵
3. 각 PR의 Week 설정 확인 (GitHub GraphQL API - Projects v2 접근 필요)
4. Week 없음 → 경고 댓글 작성 (중복 방지: Bot이 작성한 경고 댓글이 이미 있으면 스킵)
5. Week 있음 → 기존 경고 댓글 삭제 (Bot이 작성한 Week 경고 댓글만)

## 보안 및 권한

### DaleStudy Organization 전용

`repo_owner !== 'DaleStudy'` 요청은 403 Forbidden 반환.

### GitHub App 필수 권한

- `contents: read`: PR 정보 조회
- `issues: write`: 댓글 작성 및 삭제
- `pull_requests: read`: PR 목록 및 상태 조회
- `organization_projects: read`: Projects v2의 Week 필드 접근 (GraphQL API)

### Secrets 관리

**절대 커밋 금지**: `.env`, `.dev.vars`, `*.pem`, `*.key`

#### Cloudflare Workers Secrets (프로덕션)

```bash
wrangler secret put APP_ID        # GitHub App ID
wrangler secret put PRIVATE_KEY   # GitHub App Private Key (PEM)
```

#### 로컬 개발 (.dev.vars)

```
APP_ID=123456
PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

## 배포

### Cloudflare Workers

```bash
wrangler deploy
```

### 커스텀 도메인

- Production: https://github.dalestudy.com
- Worker.dev: https://dalestudy.daleseo.workers.dev

자세한 배포 가이드는 `DEPLOYMENT.md` 참고.

## GitHub Organization Webhook 설정

### 1. Webhook URL 등록

**Organization Settings** → **Webhooks** → **Add webhook**

- **Payload URL**: `https://github.dalestudy.com/webhooks`
- **Content type**: `application/json`
- **Secret**: 안전한 랜덤 문자열 (Worker secrets에도 동일하게 설정)

### 2. 이벤트 구독

**Which events would you like to trigger this webhook?**
- ☑️ **Projects v2 items** (`projects_v2_item` 이벤트)
- ☑️ **Pull requests** (`pull_request` 이벤트)

### 3. Worker Secrets 설정

```bash
wrangler secret put WEBHOOK_SECRET
# 프롬프트에서 GitHub webhook secret 입력
```

### 4. GitHub App 권한 확인

**Organization Settings** → **GitHub Apps** → **DaleStudy App**

필수 권한:
- **Organization projects**: Read & Write
- **Pull requests**: Read
- **Issues**: Read & Write (댓글 작성/삭제)

## 수동 호출 (선택사항)

전체 PR을 한 번에 검사하고 싶을 때:

```bash
curl -X POST https://github.dalestudy.com/check-weeks \
  -H "Content-Type: application/json" \
  -d '{"repo_owner": "DaleStudy", "repo_name": "leetcode-study"}'
```

## 중요한 제약사항

### Cloudflare Workers 환경

- ❌ Node.js 모듈 사용 불가 (crypto, buffer 등)
- ✅ Web 표준 API만 사용 (fetch, Web Crypto API)
- ❌ npm 패키지 대부분 호환 안 됨 (@octokit/app 등)
- ✅ 순수 JavaScript + Web APIs로 구현

## 새 기능 추가 가이드

새로운 자동화 기능을 추가할 때 다음 단계를 따르세요:

1. **엔드포인트 추가**: `index.js`의 `fetch()` 함수에 새로운 pathname 라우팅 추가
2. **핸들러 함수 작성**: 비즈니스 로직을 별도 함수로 분리 (예: `handleCheckAllPrs`)
3. **GitHub App 권한 확인**: 필요한 권한이 있는지 확인하고 없으면 추가
4. **문서 업데이트**: AGENTS.md, README.md에 새 기능 문서화
5. **테스트**: 로컬(`wrangler dev`)에서 먼저 테스트 후 배포

## 코드 수정 시 주의사항

1. **Octokit 사용 금지**

   - Cloudflare Workers에서 작동하지 않음
   - fetch API 직접 사용

2. **Private Key 처리**

   - PKCS8 또는 PKCS1 형식 지원
   - Web Crypto API로 import

3. **GraphQL 쿼리 주의**

   - GraphQL 쿼리에서 변수를 문자열 템플릿으로 직접 삽입 (GraphQL 변수 문법 사용 안 함)
   - 입력값 검증이 중요 (SQL Injection 스타일 취약점 방지)

4. **에러 핸들링**

   - Worker는 에러 발생 시 500 반환
   - 로그는 `wrangler tail`로 확인

5. **CORS 헤더**

   - 모든 응답에 CORS 헤더 포함 (`Access-Control-Allow-Origin: *`)

6. **코드 재사용**

   - GitHub 인증 로직 (`generateGitHubAppToken`, `createJWT` 등)은 모든 기능에서 공통으로 사용
   - 새 기능 추가 시 기존 유틸리티 함수 활용

## 관련 문서

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [GitHub Apps API](https://docs.github.com/en/apps)
- [GitHub GraphQL API](https://docs.github.com/en/graphql)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
