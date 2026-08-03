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
├── index.js              # Worker 메인 코드 (엔드포인트 라우팅)
├── wrangler.jsonc        # Cloudflare Workers 설정과 vars
├── package.json          # Vitest 테스트 스크립트 및 devDependencies
├── bun.lock              # Bun 의존성 lockfile
├── vitest.config.js      # Cloudflare Workers Vitest integration 설정
├── .github/workflows/    # CI 워크플로우 (bun install → bun run test)
├── handlers/             # 기능별 핸들러와 핸들러 단위 테스트
├── utils/                # 공통 유틸리티와 유틸리티 단위 테스트
├── tests/                # Worker runtime smoke test와 교차 모듈 테스트
├── README.md             # 프로젝트 설명
├── AGENTS.md             # 이 파일 (AI 에이전트 가이드)
├── CLAUDE.md             # Claude Code 참조 파일 (AGENTS.md로 리다이렉트)
└── *.pem                 # GitHub App Private Keys (커밋 제외)
```

### 코드 구조 설명

- **index.js**: 엔드포인트 라우팅만 담당. pathname별 핸들러 호출
- **handlers/**: 기능별 핸들러와 `*.test.js` 핸들러 단위 테스트
  - `check-weeks.js`: PR Week 설정 검사, 댓글 작성/삭제
  - `webhooks.js`: GitHub webhook 이벤트 처리
  - `internal-dispatch.js`: self-fetch 내부 AI 핸들러 디스패치
  - `approve_prs.js`, `merge_prs.js`: PR 일괄 승인/병합
- **utils/**: 여러 핸들러에서 공통으로 사용하는 유틸리티와 `*.test.js` 유틸리티 단위 테스트
  - `cors.js`: CORS 헤더 관리 및 응답 생성 (`corsResponse`, `errorResponse`)
  - `github.js`: GitHub App 인증 (JWT, Installation Token), RSA 서명
  - `webhook.js`: Webhook signature 검증
- **tests/**: Worker runtime smoke test, subrequest budget, cross-module 테스트
- **vitest.config.js**: `@cloudflare/vitest-pool-workers`가 `wrangler.jsonc`를 읽도록 설정

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
import { newFeature } from "./handlers/new-feature.js";

if (url.pathname === "/new-feature") {
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

`repo_owner` 생략 시 기본값으로 `DaleStudy`가 사용됩니다.

```json
{
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

#### `POST /approve-prs`

열려있는 답안 제출 PR을 일괄 승인합니다. `excludes` 배열로 특정 PR을 제외합니다. 이미 승인된 PR, `maintenance` 라벨, Draft 상태의 PR은 자동으로 스킵됩니다.

**Request:**

```json
{ "repo_name": "leetcode-study", "excludes": [1972] }
```

**Response:**

```json
{
  "success": true,
  "action": "approve",
  "repo": "DaleStudy/leetcode-study",
  "total_open_prs": 5,
  "processed": 2,
  "approved": 2,
  "skipped": 0,
  "results": [
    { "pr": 1970, "title": "week8 solutions", "approved": true },
    { "pr": 1971, "title": "week8 extras", "approved": true }
  ]
}
```

#### `POST /merge-prs`

열려있는 PR을 일괄 병합합니다. 기본 병합 방식은 `squash`이며 `merge_method` 값으로 `merge | squash | rebase` 중 선택할 수 있습니다. `excludes`로 특정 PR을 제외할 수 있습니다. 승인 리뷰가 없거나 `maintenance` 라벨이 붙은 PR, Draft PR, GitHub `mergeable_state !== "clean"` PR은 스킵되며 `unknown`/`behind` 상태는 최대 1초 후 한 번 더 확인합니다.

**Request:**

```json
{
  "repo_name": "leetcode-study",
  "merge_method": "squash",
  "excludes": [1972]
}
```

**Response:**

```json
{
  "success": true,
  "action": "merge",
  "repo": "DaleStudy/leetcode-study",
  "merge_method": "squash",
  "total_open_prs": 5,
  "processed": 2,
  "merged": 2,
  "skipped": 0,
  "results": [
    { "pr": 1970, "title": "week8 solutions", "merged": true, "sha": "abc123" },
    { "pr": 1971, "title": "week8 extras", "merged": true, "sha": "def456" }
  ]
}
```

### 3. 워크플로우

1. Open PR 목록 조회 (GitHub REST API)
2. `maintenance` 라벨 있는 PR 스킵
3. 각 PR의 Week 설정 확인 (GitHub GraphQL API - Projects v2 접근 필요)
4. Week 없음 → 경고 댓글 작성 (중복 방지: Bot이 작성한 경고 댓글이 이미 있으면 스킵)
5. Week 있음 → 기존 경고 댓글 삭제 (Bot이 작성한 Week 경고 댓글만)

### 4. AI 핸들러 Worker 분리 아키텍처

PR 이벤트를 받으면 webhook 핸들러가 두 AI 핸들러(`tagPatterns`, `postLearningStatus`)를 **별도 Worker invocation**으로 분리 디스패치한다. 각 invocation은 독립적인 Cloudflare subrequest 예산(50)을 가지므로 파일이 많은 PR에서도 예산 초과를 방지한다.

```
GitHub webhook
   │
   ▼
[Invocation #1] webhook 핸들러           ← 50 subrequest 예산
   │  ctx.waitUntil(fetch("/internal/tag-patterns"))      ─┐  self-fetch는
   │  ctx.waitUntil(fetch("/internal/learning-status"))   ─┤  외부 요청이라
   │                                                       │  새 invocation 트리거
   ├──────────────▶ [Invocation #2] tagPatterns          ◀─┘  ← 독립 50 예산
   │
   └──────────────▶ [Invocation #3] postLearningStatus      ← 독립 50 예산
```

- `INTERNAL_SECRET`과 `WORKER_URL`이 모두 설정되어야 활성화된다. 둘 중 하나라도 없으면 기존처럼 같은 invocation에서 순차 실행(subrequest 예산 공유)되어 파일이 많은 PR에서 예산을 초과할 수 있다.
- 내부 엔드포인트는 `/internal/tag-patterns`, `/internal/learning-status`이며 `X-Internal-Secret` 헤더로 인증한다.
- 참고: `tests/subrequest-budget.test.js`가 5개 파일 변경 시나리오에서 각 핸들러의 fetch 호출 수(`tagPatterns` 20회, `postLearningStatus` 31회)를 회귀 테스트로 박아둔다.

## 보안 및 권한

### DaleStudy Organization 전용

`repo_owner !== 'DaleStudy'` 요청은 403 Forbidden 반환.

### GitHub App 필수 권한

- `contents: read`: PR 정보 조회
- `issues: write`: 댓글 작성 및 삭제
- `pull_requests: read & write`: PR 목록/상태 조회, 리뷰 생성, 병합 수행
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
- Worker.dev: https://github.dalestudy.workers.dev

자세한 배포 가이드는 `DEPLOYMENT.md` 참고.

## GitHub App Webhook 설정

### 1. GitHub App 설정 페이지 접근

```
https://github.com/settings/apps/dalestudy
```

### 2. General 탭 - Webhook 설정

- **Webhook URL**: `https://github.dalestudy.com/webhooks`
- **Webhook Secret**: (선택사항) 안전한 랜덤 문자열
- **✅ Active**: 체크

### 3. Permissions & events 탭 - 권한 설정

**Repository permissions:**

- **Contents**: Read
- **Issues**: Read & write (issue_comment 이벤트용)
- **Metadata**: Read
- **Pull requests**: Read & write
- **Projects**: Read & write (Projects V2)

**Subscribe to events:**

- ☑️ **Issue comments** (`issue_comment` - AI 코드 리뷰)
- ☑️ **Projects v2 item** (`projects_v2_item` - Week 체크)
- ☑️ **Pull requests** (`pull_request` - Week 체크)

### 4. Worker Secrets 설정

```bash
# OpenAI API Key (AI 코드 리뷰용, 필수)
wrangler secret put OPENAI_API_KEY

# Webhook Secret (선택사항)
wrangler secret put WEBHOOK_SECRET

# Internal Dispatch Secret (AI 핸들러 Worker 분리용, 권장)
# 설정하면 tagPatterns, learningStatus가 별도 Worker 호출로
# 디스패치되어 각각 독립적인 subrequest 예산을 가짐.
# WORKER_URL과 함께 설정되어야 활성화된다.
wrangler secret put INTERNAL_SECRET
```

`WORKER_URL`은 `wrangler.jsonc`의 `vars`에 정의되어 있어 기본 배포에는 추가 설정이 필요 없다. 스테이징/다른 계정 등으로 배포할 때만 덮어쓰면 된다.

### 5. GitHub App 설치

저장소에 App이 설치되어 있는지 확인:

```
https://github.com/apps/dalestudy/installations
```

**DaleStudy organization에 설치**되어 있어야 하며, **leetcode-study 저장소 접근 권한** 필요

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

## 테스트

이 프로젝트는 Cloudflare Workers Vitest integration을 사용합니다. Vitest로 테스트를 실행하고, Worker 런타임과 바인딩이 필요한 테스트는 Cloudflare 테스트 도구를 사용합니다.

### 테스트 실행

테스트는 `handlers/`(핸들러 단위 테스트), `utils/`(유틸리티 단위 테스트), `tests/`(Worker runtime smoke test와 교차 모듈 테스트)로 나뉜다. 모듈 모킹은 Vitest의 `vi.mock()`을 사용하고, Worker runtime과 bindings가 필요한 테스트는 `cloudflare:test`와 `cloudflare:workers`를 사용한다.

```bash
# 의존성 설치
bun install

# 전체 테스트 실행
bun run test

# 감시 모드
bun run test:watch

# 특정 파일만 실행
bun run test -- handlers/webhooks.test.js
```

Bun 설치: https://bun.sh/docs/installation

### 테스트 파일 작성 규칙

- 테스트 파일은 대상 파일과 같은 디렉토리에 `*.test.js` 이름으로 배치합니다.
  - 예: `handlers/webhooks.js` → `handlers/webhooks.test.js`
- `vitest`에서 제공하는 API(`describe`, `it`, `expect`, `vi`, `beforeEach`)를 사용합니다.
- 외부 의존성(`utils/github.js` 등)은 `vi.mock()`으로 대체하고, `fetch`는 `globalThis.fetch = vi.fn()...`로 스텁합니다.

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
}));

import { checkWeeks } from "./check-weeks.js";

describe("checkWeeks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("returns 403 for non-DaleStudy organization", async () => {
    const request = new Request("https://example.com/check-weeks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_owner: "OtherOrg", repo_name: "leetcode-study" }),
    });

    const response = await checkWeeks(request, {});
    expect(response.status).toBe(403);
  });
});
```

### CI 자동 실행

`.github/workflows/integration.yaml`이 모든 Pull Request와 `main` 브랜치 푸시에서 `bun install` 다음 `bun run test`를 자동 실행합니다. 테스트가 실패하면 PR 체크가 실패하므로, 머지 전에 반드시 통과시켜야 합니다.

## 새 기능 추가 가이드

새로운 자동화 기능을 추가할 때 다음 단계를 따르세요:

1. **엔드포인트 추가**: `index.js`의 `fetch()` 함수에 새로운 pathname 라우팅 추가
2. **핸들러 함수 작성**: 비즈니스 로직을 별도 함수로 분리 (예: `handleCheckAllPrs`)
3. **GitHub App 권한 확인**: 필요한 권한이 있는지 확인하고 없으면 추가
4. **테스트 작성**: 핸들러 옆에 `*.test.js`를 추가하고 `bun run test`로 통과 확인 (위 "테스트" 섹션 참고)
5. **문서 업데이트**: AGENTS.md, README.md에 새 기능 문서화
6. **로컬 실행 테스트**: `wrangler dev`로 실제 엔드포인트 동작 확인 후 배포

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

7. **코멘트 숨김 마커 직렬화 포맷 변경**
   - 코멘트에 `<!-- xxx-data: ... -->` 형태로 숨겨 저장하는 데이터의 직렬화 포맷(객체↔배열 등)을 바꿀 때는 **정규식·문서 주석·테스트를 같은 PR에서 함께 갱신**
   - 파싱이 `Array.isArray` 같은 방어 코드로 빈 값에 fallback하면 회귀가 조용히 묻혀 디버깅이 어려워짐

## 관련 문서

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [GitHub Apps API](https://docs.github.com/en/apps)
- [GitHub GraphQL API](https://docs.github.com/en/graphql)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
