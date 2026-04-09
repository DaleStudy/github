# DaleStudy GitHub App – 코드베이스 분석 보고서

조사 일자: 2026-04-08
대상 저장소: `/Users/lkhoony/Desktop/github` (Cloudflare Worker 기반 GitHub App)

---

## 1. 한눈에 보는 개요

DaleStudy 조직의 LeetCode 스터디 저장소(`DaleStudy/leetcode-study`)를 자동화하기 위한 **Cloudflare Workers** 기반 GitHub App입니다. PR이 올라오면 다음 4가지 자동화를 수행합니다.

1. **Week 라벨(프로젝트 필드) 누락 체크 / 경고 댓글**
2. **알고리즘 패턴 태깅** (각 솔루션 파일에 OpenAI로 패턴 분석 → 파일 단위 review comment)
3. **학습 현황 댓글** (사용자의 누적 풀이 + 이번 PR 분석을 표 형태로 issue comment)
4. **AI 코드 리뷰** (`@dalestudy` 멘션 시 OpenAI로 PR diff 리뷰, 또는 `approve` 시 자동 승인)

추가로 운영자 수동 호출용 엔드포인트(`/check-weeks`, `/approve-prs`, `/merge-prs`)도 제공합니다.

질문에서 말씀하신 "PR이 올라오면 파일을 가져와 시간/공간 복잡도를 분석" 부분은 [utils/openai.js](utils/openai.js#L15) 의 `generateCodeReview` 시스템 프롬프트에 명시되어 있습니다. 단, **자동으로 매번 실행되는 것은 아니고**, 실제로는 멘션(`@dalestudy`)이 있을 때만 작동합니다 — 자동 실행되는 것은 패턴 태깅과 학습 현황입니다 ([handlers/webhooks.js:257-289](handlers/webhooks.js#L257-L289)). **여기가 첫 번째로 의도와 코드가 어긋나는 지점입니다.**

---

## 2. 진입점 (Entry Point)

### [index.js](index.js)
- Cloudflare Workers의 표준 `export default { fetch }` 구조.
- 모든 요청은 `POST`만 허용 (`OPTIONS`는 CORS preflight 처리).
- 라우팅 테이블 (전부 `if pathname ===` 분기):
  | Pathname | 핸들러 | 용도 |
  |---|---|---|
  | `/webhooks` | `handleWebhook` | GitHub Webhook 수신 (서명 검증 포함) |
  | `/check-weeks` | `checkWeeks` | 모든 Open PR Week 검사 (수동) |
  | `/approve-prs`, `/approve_prs` | `approvePrs` | 일괄 승인 (수동) |
  | `/merge-prs`, `/merge_prs` | `mergePrs` | 일괄 병합 (수동) |
- `/webhooks`는 `request.text()`로 raw body를 받아 HMAC 검증 후, **새 Request 객체를 만들어서** 핸들러에 전달합니다 (body가 한 번 read되면 다시 못 읽기 때문).

---

## 3. 폴더 구조 및 역할

```
.
├── index.js                  # 라우터 (엔트리포인트)
├── wrangler.jsonc            # Cloudflare Workers 설정
├── test-migration.sh         # 마이그레이션 테스트 스크립트
├── handlers/                 # 엔드포인트별 비즈니스 로직
│   ├── webhooks.js           # GitHub webhook 이벤트 디스패처 (메인)
│   ├── check-weeks.js        # Week 일괄 검사
│   ├── approve_prs.js        # 일괄 승인
│   ├── merge_prs.js          # 일괄 병합
│   ├── tag-patterns.js       # 알고리즘 패턴 태깅 오케스트레이션
│   └── learning-status.js    # 학습 현황 오케스트레이션
└── utils/                    # 재사용 유틸
    ├── github.js             # GitHub App 인증 (JWT/Installation Token), GraphQL, 헤더
    ├── webhook.js            # HMAC SHA-256 webhook 서명 검증
    ├── cors.js               # corsResponse / errorResponse / preflightResponse
    ├── constants.js          # ALLOWED_ORG, ALLOWED_REPO, MAINTENANCE_LABEL 등
    ├── validation.js         # validateOrganization, hasMaintenanceLabel, isClosedPR
    ├── pullRequests.js       # PR 목록/메타 fetch
    ├── prActions.js          # hasApprovedReview, safeJson 등 PR 액션 헬퍼
    ├── prReview.js           # AI 코드 리뷰 (diff fetch + OpenAI + 댓글 작성)
    ├── prWeeks.js            # ensureWarningComment / removeWarningComment / handleWeekComment
    ├── openai.js             # OpenAI Chat Completions 래퍼 3종
    ├── learningData.js       # problem-categories.json, repo tree, PR files fetch
    └── learningComment.js    # 학습 현황 댓글 포맷터 + upsert
```

---

## 4. 실행 흐름 (Webhook 기준)

[handlers/webhooks.js](handlers/webhooks.js) 의 `handleWebhook`이 디스패처입니다.

1. **공통 게이트** ([webhooks.js:37-49](handlers/webhooks.js#L37-L49))
   - `payload.organization?.login !== "DaleStudy"` → 무시
   - `payload.repository?.name !== ALLOWED_REPO("leetcode-study")` → 무시
2. **이벤트 분기** (`X-GitHub-Event` 헤더)
   - `projects_v2_item` → `handleProjectsV2ItemEvent`
   - `pull_request` → `handlePullRequestEvent`
   - `issue_comment` → `handleIssueCommentEvent`
   - `pull_request_review_comment` → `handlePullRequestReviewCommentEvent`

### 4.1 `pull_request` 이벤트 — 우리가 가장 신경 써야 할 흐름
[webhooks.js:212-297](handlers/webhooks.js#L212-L297)

- `opened`/`reopened`/`synchronize`만 처리.
- maintenance 라벨이 있으면 early exit.
- App token 발급.
- **opened/reopened일 때만** Week 체크 (3초 sleep 후 — 프로젝트 자동 추가 race 회피).
- `OPENAI_API_KEY`가 있으면:
  1. `tagPatterns(...)` — 솔루션 파일별 패턴 태깅 (try/catch로 무시)
  2. `postLearningStatus(...)` — 학습 현황 댓글 (try/catch로 무시)

### 4.2 패턴 태깅 — [handlers/tag-patterns.js](handlers/tag-patterns.js)
1. PR draft / maintenance 라벨이면 skip.
2. `GET /pulls/{n}/files?per_page=100`로 변경 파일 목록 조회.
3. `^[^/]+/[^/]+\.[^.]+$` 정규식으로 `{문제폴더}/{사용자}.ext` 형태만 필터.
4. 기존 Bot이 단 패턴 코멘트(`<!-- dalestudy-pattern-tag -->`)를 모두 삭제.
5. 각 파일을 `raw_url`로 다운로드 → 20K자 trim → `generatePatternAnalysis`로 OpenAI 호출 → 파일 단위 review comment(`subject_type: "file"`) 작성.

### 4.3 학습 현황 — [handlers/learning-status.js](handlers/learning-status.js)
1. 저장소 루트의 `problem-categories.json`을 raw로 fetch (없으면 조용히 skip).
2. `git/trees/main?recursive=1`로 사용자가 푼 모든 문제 추출 (`{문제}/{username}.ext`).
3. PR files API로 이번 PR 제출 파일 추출.
4. 각 제출 파일에 대해 `generateApproachAnalysis` 호출 (의도된 접근법과 일치하는지 boolean + 1문장 설명).
5. `buildCategoryProgress`로 카테고리별 진행도(정렬: 진행률 내림차순) 계산.
6. `formatLearningStatusComment`로 마크다운 표 작성.
7. `upsertLearningStatusComment`로 기존 봇 댓글이 있으면 PATCH, 없으면 POST.

### 4.4 issue_comment / review_comment — 멘션 기반
- `@dalestudy` 멘션 감지 → `extractMentionAndRequest`
- 텍스트가 `approve`/`승인`이면 → `handleApprovalRequest` (closed/draft/maintenance/이미 승인 체크 후 `event: "APPROVE"` POST)
- 그 외이면 → `performAIReview` (PR diff fetch → OpenAI → 댓글 작성, line comment에는 thread reply로)
- 시작/성공/실패 시 `eyes`/`+1`/`-1` reaction을 댓글에 답니다.

---

## 5. 인증 (utils/github.js)

`generateGitHubAppToken(env)`이 핵심:
1. `createJWT(APP_ID, PRIVATE_KEY)` — RS256 JWT 직접 서명 (Web Crypto API). `iat = now-60`, `exp = now+10min`.
2. `GET /app/installations`로 전체 설치 목록 조회 → `account.login === "DaleStudy"` 필터.
3. `POST /app/installations/{id}/access_tokens` → installation token (1시간 유효).

`getGitHubHeaders(token)` — 모든 REST 호출에서 공유하는 헤더 빌더.
`getPRInfoFromNodeId(nodeId, token)` — `projects_v2_item` 이벤트에서 PR 번호/리포지토리를 GraphQL로 역조회.

---

## 6. OpenAI 사용 (utils/openai.js)

세 가지 함수 모두 `gpt-4.1-nano` 모델 사용. 모두 직접 fetch (SDK 미사용 — Workers 호환).

| 함수 | 용도 | 응답 형식 | max_tokens |
|---|---|---|---|
| `generateCodeReview` | 멘션 기반 PR 리뷰 (Q&A or 전체) | 자유 텍스트 | 2000 |
| `generatePatternAnalysis` | 단일 파일 알고리즘 패턴 분류 | JSON `{patterns, description}` | 500 |
| `generateApproachAnalysis` | 풀이가 의도한 접근법과 맞는지 | JSON `{matches, explanation}` | 200 |

`generateCodeReview` 시스템 프롬프트에 시간/공간 복잡도 분석 요구가 들어 있습니다 ([openai.js:31-36](utils/openai.js#L31-L36)).

---

## 7. 발견된 버그 / 개선사항

### 🔴 버그 (실제 동작에 영향 있음)

1. **PKCS1 Private Key 분기는 사실상 죽은 코드 / 동작 안 함** — [utils/github.js:147-174](utils/github.js#L147-L174)
   `importPrivateKey`가 `BEGIN RSA PRIVATE KEY` 헤더(=PKCS1)를 detect하긴 하지만, `crypto.subtle.importKey("pkcs8", ...)`로 무조건 PKCS8로 import합니다. PKCS1 키를 넣으면 무조건 실패합니다. AGENTS.md는 "PKCS8/PKCS1 모두 지원"이라고 적혀 있는데 실제론 PKCS8만 지원됨. 둘 중 하나로 정리 필요 (문서를 고치든, ASN.1 wrapping 코드를 추가하든).

2. **`postReviewComment`/`postThreadReply`/`addReactionToComment`에 `Content-Type` 헤더 누락** — [utils/prReview.js:51-59](utils/prReview.js#L51-L59), [prReview.js:79-87](utils/prReview.js#L79-L87), [prReview.js:111-115](utils/prReview.js#L111-L115)
   `getGitHubHeaders`는 `Content-Type`을 포함하지 않는데, JSON body를 보내면서 `Content-Type: application/json`을 추가하지 않습니다. GitHub REST API는 너그러워서 보통 통과하지만, 표준 위반이고 일부 엔드포인트에서 거부될 수 있습니다. 또한 응답 상태를 **확인하지 않습니다** (`if (!response.ok)` 없음) — 댓글 작성이 실패해도 조용히 성공한 것처럼 동작합니다. 비교 대상으로 [handlers/webhooks.js:632-645](handlers/webhooks.js#L632-L645) 의 승인 코드는 명시적으로 `Content-Type`을 추가하고 `response.ok`를 검사합니다 — 이 패턴을 prReview.js에도 적용해야 합니다.

3. **`pull_request.synchronize` 시 매번 패턴 태깅이 다시 돌아감** — [handlers/webhooks.js:257-272](handlers/webhooks.js#L257-L272) + [tag-patterns.js:75-77](handlers/tag-patterns.js#L75-L77)
   `tagPatterns`는 진입할 때마다 기존 봇 패턴 코멘트를 **모두 삭제하고 다시 작성**합니다. PR에 커밋이 푸시될 때마다 이 작업이 발생하는데, 변경되지 않은 파일까지 다시 OpenAI 호출이 일어납니다. 비용 + rate limit 리스크가 있습니다. 최소한 "이번 push에서 변경된 파일만" 처리하거나, file SHA를 코멘트 본문에 박아두고 동일하면 skip하는 로직이 필요합니다.

4. **`fetchUserSolutions`의 truncated 트리** — [utils/learningData.js:72-76](utils/learningData.js#L72-L76)
   `git/trees/main?recursive=1`은 7MB / 100k 엔트리 제한이 있어 큰 저장소에서 `truncated: true`가 나옵니다. 현재는 console.warn만 하고 그대로 진행해서, 사용자의 누적 풀이 수가 **실제보다 적게** 카운트됩니다. leetcode-study는 충분히 큰 저장소이므로 곧 부딪힙니다. Tree API를 디렉터리별로 재귀 호출하거나 GraphQL로 대체해야 합니다.

5. **`extractMentionAndRequest`의 `@dalestudy bot` 같은 입력 처리** — [handlers/webhooks.js:313-314](handlers/webhooks.js#L313-L314)
   `/@dalestudy\s*(.*)/i`는 멘션 뒤 텍스트를 통째로 잡습니다. `@dalestudy bot please review`처럼 봇 닉네임이 끼면 `userRequest`가 `"bot please review"`가 되어 `genericReviewKeywords` 매칭이 안 되고 Q&A 모드로 동작합니다. 또한 멘션이 댓글 끝에 있으면 빈 문자열이 아니라 줄바꿈/마침표를 잡을 수 있습니다.

6. **`handleProjectsV2ItemEvent`의 race condition** — [webhooks.js:165-184](handlers/webhooks.js#L165-L184)
   `created` 액션 처리 시 곧바로 `handleWeekComment`로 Week 값을 GraphQL 조회하는데, 프로젝트에 막 추가된 직후에는 Week 필드가 아직 비어 있을 가능성이 매우 높습니다. 그러면 경고 댓글이 달리고, 그 직후 사용자가 Week를 설정하면 또 `edited` 이벤트가 와서 댓글이 지워집니다. 사용자 경험상 잠깐 경고가 깜빡이는 문제가 있습니다. `pull_request opened` 핸들러처럼 짧은 sleep이 있으면 좋습니다.

7. **`fetchPRSubmissions`/`tag-patterns`의 100개 페이지 한계** — [learningData.js:130-134](utils/learningData.js#L130-L134), [tag-patterns.js:50](handlers/tag-patterns.js#L50)
   `per_page=100`만 호출하고 페이지네이션을 안 합니다. PR이 100개 넘는 파일을 가질 일은 드물지만, 공동 작업 PR에서 누락 가능. 최소한 `Link` 헤더를 보고 추가 페이지가 있을 때 처리해야 합니다.

### 🟡 코드 품질 / 구조 개선

8. **라우팅이 if/else 체인** — [index.js:28-70](index.js#L28-L70)
   엔드포인트가 6개 됐고 alias도 생기고 있습니다. `const routes = { "/webhooks": handleWebhook, ... }` 객체 lookup으로 정리하면 가독성/추가 비용이 줄어듭니다.

9. **`/webhooks` 분기 안에서 Request를 재생성하는 로직이 진입점에 노출됨** — [index.js:30-54](index.js#L30-L54)
   서명 검증과 body 보존은 `verifyAndForward` 같은 헬퍼로 빼서 `index.js`는 순수 라우터로 유지하는 게 깔끔합니다.

10. **Webhook 전체가 동기적으로 GitHub에 응답** — [webhooks.js:212-297](handlers/webhooks.js#L212-L297)
    `pull_request opened` 이벤트 하나에서 (a) 3초 sleep, (b) Week 체크 + 댓글, (c) 패턴 태깅 (파일 N개 × OpenAI 호출), (d) 학습 현황 (파일 N개 × OpenAI 호출 + tree fetch)을 **순차적으로** 실행한 뒤에야 응답합니다. GitHub webhook은 10초 안에 응답하지 않으면 retry 됩니다. 파일이 5개만 넘어가도 timeout 위험이 있습니다.
    → Cloudflare Workers의 [`ctx.waitUntil()`](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/#contextwaituntil)을 사용해서 **즉시 200 응답하고 백그라운드에서 처리**하는 패턴으로 바꾸는 것이 가장 큰 안정성 개선입니다. 현재 코드는 `fetch(request, env)` 시그니처라 `ctx`를 받지 않는데, `fetch(request, env, ctx)`로 바꾸면 됩니다.

11. **`tagPatterns`와 `postLearningStatus`는 같은 PR files API를 두 번 호출** — [tag-patterns.js:49-53](handlers/tag-patterns.js#L49-L53), [learningData.js:116-120](utils/learningData.js#L116-L120)
    동일 PR에 대해 동일 API 호출이 두 번 발생. 한 번 fetch해서 두 함수에 주입하면 절약됩니다.

12. **"파일 단위 review comment"는 GitHub API 측에서도 비공식 기능** — [tag-patterns.js:202-217](handlers/tag-patterns.js#L202-L217)
    `subject_type: "file"`은 비교적 최근의 문서화되지 않은 동작이고, 깨질 가능성이 있습니다. 파일 단위 코멘트가 깨졌을 때 fallback(예: PR issue 댓글로 전환)이 없습니다.

13. **OpenAI 호출 응답에 대한 가벼운 schema 검증 부족** — [utils/openai.js:163-174](utils/openai.js#L163-L174)
    `generatePatternAnalysis`에서 `JSON.parse`가 실패해도 try/catch가 없습니다. (`generateApproachAnalysis`에는 있음 — 일관성 부재.) `gpt-4.1-nano`가 가끔 JSON 외 텍스트를 토하면 전체 PR 처리가 throw합니다. 단일 파일 catch 덕분에 최악은 면했지만, 불필요한 분기입니다.

14. **GitHub API 응답 본문 파싱 시 `errorData.message` 의존** — [webhooks.js:582-587](handlers/webhooks.js#L582-L587), [learningComment.js:181-186](utils/learningComment.js#L181-L186)
    `errorData`가 배열일 수도 있고, `message` 외 `errors[]`만 있을 수도 있습니다. `safeJson` 같은 래퍼는 있지만 활용이 일관되지 않습니다.

15. **`handleApprovalRequest` 안에서 "이미 승인" 체크 시 봇 토큰의 reviews만 봐야** — [webhooks.js:617-629](handlers/webhooks.js#L617-L629)
    현재 `hasApprovedReview`가 어떻게 구현됐는지에 따라 다르지만, 사람이 이미 승인한 PR에 대해서도 "이미 승인됨"으로 거절하면 좀 어색합니다 — 봇 입장에서는 승인 가능해야 합니다. (utils/prActions.js 확인 권장.)

16. **상수 분산** — [utils/constants.js](utils/constants.js) 와 각 핸들러
    `COMMENT_MARKER`가 [tag-patterns.js:12](handlers/tag-patterns.js#L12) 와 [learningComment.js:10](utils/learningComment.js#L10) 에 따로 정의돼 있습니다. 봇 댓글 마커는 향후 늘어날 가능성이 크니 `constants.js`로 모으는 게 좋습니다.

17. **재시도 / 백오프 없음**
    GitHub / OpenAI 호출 모두 5xx에 대한 재시도가 없습니다. Workers에는 작업 시간이 짧아 큰 재시도는 어렵지만, 1회 즉시 retry 정도는 안정성에 큰 도움이 됩니다.

18. **`generatePatternAnalysis`의 패턴 목록이 하드코딩** — [openai.js:99-115](utils/openai.js#L99-L115)
    16개 패턴이 시스템 프롬프트에 박혀 있어 추가/수정 시 코드 수정이 필요. `constants.js`로 분리하면 테스트도 쉬워집니다.

19. **`buildCategoryProgress`의 정렬 기준** — [learning-status.js:46-53](handlers/learning-status.js#L46-L53)
    진행률 내림차순 정렬은 "이미 잘하는 카테고리"가 위로 올라옵니다. UX 관점에서는 "취약한(진행률 낮은) 카테고리"가 위에 있는 게 학습 동기부여에 더 도움될 수 있습니다 — 도메인 의도와 맞는지 확인 필요.

20. **`MAX_FILE_SIZE`가 두 곳에 다른 값으로 정의** — [tag-patterns.js:14](handlers/tag-patterns.js#L14) (20000) / [learning-status.js:19](handlers/learning-status.js#L19) (15000) / [openai.js:200](utils/openai.js#L200) (15000 한 번 더 slice)
    학습 현황은 15K, 패턴 태깅은 20K. 큰 의미 차이 없으면 통일하고 `constants.js`로 옮기는 것이 유지보수성에 도움됩니다.

### 🟢 사소한 점 / 스타일

21. 파일 이름 컨벤션이 섞여 있음 — `check-weeks.js`(kebab) vs `approve_prs.js`(snake). 통일 권장.
22. 라우팅에서 alias 두 개씩(`/approve-prs` + `/approve_prs`)을 둔 것은 URL 일관성 자체를 잡지 못해서 생긴 hack입니다. 한 쪽만 정식으로 두고 다른 쪽은 301 redirect로 안내하는 것이 좋습니다.
23. `console.log`가 매우 많습니다. `wrangler tail` 디버깅을 위한 것이지만, 운영 환경에서는 log level 분리 (`LOG_LEVEL` env 등)가 있으면 좋습니다.
24. AGENTS.md의 폴더 구조 다이어그램이 [현재 구조](handlers/)와 일치하지 않습니다 (`approve_prs.js`, `merge_prs.js`, `tag-patterns.js`, `learning-status.js` 누락). 문서 갱신 필요.

---

## 8. "복잡도 분석 자동화"를 본격 구현할 때 고려할 점

질문 의도가 "PR이 올라오면 시간/공간 복잡도를 자동 분석해주는" 기능을 강화하는 것이라면, 다음 방향을 권장합니다.

1. **자동 트리거**: 현재 복잡도 분석은 멘션이 있어야 동작합니다. 새 PR이 열렸을 때 자동으로 도는 별도 핸들러(`handlers/complexity-analysis.js`)를 만들고 [webhooks.js:212-297](handlers/webhooks.js#L212-L297) 에 연결하세요. `tagPatterns`, `postLearningStatus`와 같은 위치에 `try/catch` 래핑으로 추가하면 자연스럽습니다.
2. **파일별 분석**: PR diff 전체를 한 번에 OpenAI에 던지지 말고, `tag-patterns.js`의 패턴(파일 단위 fetch + truncate + review comment)을 그대로 차용하세요. 코드 재사용도 되고, 파일별로 결과가 정리돼서 사용자에게 더 명확합니다.
3. **결과 저장 위치**: 파일 단위 review comment + PR 본문 issue comment 두 가지 옵션. 학습 현황 댓글처럼 **upsert 패턴**(`<!-- dalestudy-complexity -->` 마커)을 쓰면 push마다 댓글이 누적되지 않아 깔끔합니다.
4. **OpenAI 응답 schema**: `{ time: "O(n log n)", space: "O(n)", reasoning: "..." }` 같은 strict JSON으로 받고 `response_format: { type: "json_object" }` 사용. 현재 [openai.js](utils/openai.js)의 두 분석 함수 패턴 그대로 따라가면 됩니다.
5. **비용 통제**: 위 6번(매 push마다 재실행) 이슈를 먼저 해결하고 나서 추가하세요. 안 그러면 비용이 두 배 이상 늘어납니다.
6. **`ctx.waitUntil()` 도입**: 위 10번. 복잡도 분석까지 추가되면 동기 처리는 거의 확실하게 webhook timeout을 일으킵니다.

---

## 9. 우선순위 높은 액션 아이템 요약

| 순위 | 항목 | 위치 |
|---|---|---|
| 1 | `ctx.waitUntil()`로 webhook 처리를 백그라운드화 | [index.js](index.js), [handlers/webhooks.js](handlers/webhooks.js) |
| 2 | `prReview.js`의 fetch 호출에 `Content-Type` + `response.ok` 검사 추가 | [utils/prReview.js:44-115](utils/prReview.js#L44-L115) |
| 3 | `tagPatterns`가 변경된 파일만 처리하도록 개선 (비용/rate limit) | [handlers/tag-patterns.js](handlers/tag-patterns.js) |
| 4 | `fetchUserSolutions`의 truncated tree 처리 | [utils/learningData.js:58-95](utils/learningData.js#L58-L95) |
| 5 | PKCS1 분기 정리 (지원하든 제거하든) + AGENTS.md 동기화 | [utils/github.js:147-174](utils/github.js#L147-L174) |
| 6 | 라우팅을 객체 lookup으로 정리 + alias 정책 결정 | [index.js:28-70](index.js#L28-L70) |
| 7 | OpenAI 응답 JSON parse 일관된 try/catch | [utils/openai.js](utils/openai.js) |
| 8 | AGENTS.md 폴더 구조/엔드포인트 목록 최신화 | [AGENTS.md](AGENTS.md) |

---

조사 범위: `index.js`, `handlers/*`, `utils/github.js`, `utils/openai.js`, `utils/learningData.js`, `utils/learningComment.js`, `utils/prReview.js`, `utils/validation.js`, `AGENTS.md`. (`utils/prWeeks.js`, `utils/pullRequests.js`, `utils/prActions.js`, `utils/cors.js`, `utils/webhook.js`, `utils/constants.js`, `handlers/check-weeks.js`, `handlers/approve_prs.js`, `handlers/merge_prs.js`는 함수 시그니처와 호출 관계만 확인.)
