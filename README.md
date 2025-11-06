# DaleStudy GitHub App

DaleStudy 조직의 자동화 작업을 처리하는 GitHub App (https://github.com/apps/dalestudy)

## 프로젝트 비전

DaleStudy 조직의 여러 repository에서 반복적인 작업들을 자동화하는 확장 가능한 플랫폼입니다.

## 현재 구현된 기능

### 1. PR Week 설정 자동 검사 (리트코드 스터디)

Fork PR에서도 작동하도록 GitHub Projects v2의 Week 필드를 조회하고, Week 설정이 누락된 PR에 자동으로 경고 댓글을 작성합니다.

**트리거 방식:**
- **실시간**: GitHub Organization Webhook (Week 설정 변경 즉시 반응)
- **수동**: REST API 직접 호출

**대상**: https://github.com/DaleStudy/leetcode-study

**설정 가이드**: `AGENTS.md`의 "GitHub Organization Webhook 설정" 섹션 참고

## 향후 확장 계획

단일 Worker에 여러 엔드포인트를 추가하여 다양한 자동화 요구사항을 처리할 예정입니다.

## 배포 방법

### 1. Cloudflare 계정 설정

1. https://dash.cloudflare.com 회원가입
2. Workers 섹션으로 이동

### 2. Wrangler CLI 설치

```bash
npm install -g wrangler
wrangler login
```

### 3. Secrets 설정

GitHub App의 credentials를 Worker secrets에 저장:

```bash
cd cloudflare-worker

# APP_ID 설정
wrangler secret put APP_ID
# 프롬프트에서 GitHub App ID 입력

# PRIVATE_KEY 설정
wrangler secret put PRIVATE_KEY
# 프롬프트에서 GitHub App Private Key 전체 내용 입력
# (-----BEGIN RSA PRIVATE KEY----- 부터 -----END RSA PRIVATE KEY----- 까지)
```

### 4. Worker 배포

```bash
wrangler deploy
```

배포 완료 후 URL이 표시됩니다:

```
https://dalestudy-week-checker.your-subdomain.workers.dev
```

## API 엔드포인트

**Base URL**: https://github.dalestudy.com

### `POST /check-weeks`

모든 Open PR에서 Week 설정을 검사하고 자동으로 댓글 작성/삭제

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

## 개발 및 테스트

### 로컬 개발

```bash
# 개발 서버 시작
wrangler dev

# 로컬 테스트 (별도 터미널)
curl -X POST http://localhost:8787/check-weeks \
  -H "Content-Type: application/json" \
  -d '{"repo_owner": "DaleStudy", "repo_name": "leetcode-study"}'
```

### 프로덕션 테스트

```bash
curl -X POST https://github.dalestudy.com/check-weeks \
  -H "Content-Type: application/json" \
  -d '{"repo_owner": "DaleStudy", "repo_name": "leetcode-study"}'
```

### 로그 확인

```bash
wrangler tail
```

## 보안

- DaleStudy organization만 허용
- CORS 헤더 설정 (모든 origin 허용)
- GitHub App credentials는 Worker secrets에 안전하게 저장
- Rate limiting은 Cloudflare에서 자동 처리

## 비용

Cloudflare Workers 무료 티어:

- 100,000 requests/day
- 10ms CPU time per request

리트코드 스터디 PR 수준이면 무료 티어로 충분합니다.

## 새 기능 추가하기

새로운 자동화 기능을 추가하려면:

1. `index.js`에 새 엔드포인트 라우팅 추가
2. 핸들러 함수 구현 (기존 `handleCheckAllPrs` 참고)
3. GitHub App 권한 확인 및 필요시 추가
4. 문서(AGENTS.md, README.md) 업데이트
5. 로컬 테스트 후 배포 (`wrangler deploy`)

자세한 가이드는 `AGENTS.md`를 참고하세요.

## 문제 해결

### Worker가 401 에러 반환

GitHub App credentials 확인:

```bash
wrangler secret list
```

APP_ID와 PRIVATE_KEY가 모두 설정되어 있어야 합니다.

### Worker가 403 에러 반환

DaleStudy organization이 아닌 경우 차단됩니다.

## 관련 문서

- **AGENTS.md**: AI 에이전트를 위한 상세 가이드 (개발자도 필독!)
- **DEPLOYMENT.md**: 처음부터 배포하는 전체 가이드
- **GitHub App**: https://github.com/organizations/DaleStudy/settings/apps/dalestudy
