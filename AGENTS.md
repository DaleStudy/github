# AGENTS.md

DaleStudy 조직의 [GitHub App](https://github.com/apps/dalestudy)이 받는 웹훅과 자동화 요청을 처리하는 Cloudflare Worker. 주 대상은 [leetcode-study](https://github.com/DaleStudy/leetcode-study) 저장소다.

- 운영: https://github.dalestudy.com (workers.dev: https://github.dalestudy.workers.dev)
- 스택: Cloudflare Workers, JavaScript(ES Modules), Vitest, Bun

## 명령어

```bash
bun install
bun run test                # 전체 테스트 (CI 와 배포 전에 같은 명령을 돈다)
bun run test -- handlers/webhooks.test.js
wrangler dev                # http://localhost:8787
wrangler tail               # 운영 로그
```

## 구조

```
index.js        엔드포인트 라우팅만 한다 (POST 만 받는다)
handlers/       기능별 핸들러와 단위 테스트(*.test.js)
utils/          공통 유틸리티와 단위 테스트 (github.js: App 인증, prActions.js: 승인·병합 공통 로직)
tests/          Worker runtime smoke test, subrequest 예산, 교차 모듈 테스트
wrangler.jsonc  Worker 설정과 공개 값(vars)
```

새 기능은 `handlers/` 에 핸들러를 만들고 `index.js` 에 경로를 추가한다. 필요한 GitHub App 권한이 있는지 확인하고, 핸들러 옆에 테스트를 둔다.

## 엔드포인트

`repo_owner` 를 받는 엔드포인트는 `DaleStudy` 가 아니면 403 이다 (생략하면 `DaleStudy`). `/check-weeks` 는 저장소도 leetcode-study 만 받는다.

| 경로                      | 하는 일                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /webhooks`          | GitHub App 웹훅 수신 (아래 "웹훅")                                                                              |
| `POST /check-weeks`       | 열린 PR 전체의 Week 설정을 검사해 경고 댓글을 달거나 지운다. `{ "repo_name" }`                                  |
| `POST /approve-prs`       | 해당 주차 풀이 PR 을 일괄 승인한다. `{ "repo_name", "week": "Week 8", "excludes"? }`                            |
| `POST /merge-prs`         | 해당 주차의 승인된 PR 을 일괄 병합한다. `{ "repo_name", "week", "excludes"?, "merge_method"? }` (기본 `squash`) |
| `POST /resolve-iteration` | 날짜가 몇 기 몇 주차인지 프로젝트 보드에서 읽는다. `{ "date": "2026-08-08" }`                                   |
| `POST /internal/*`        | 웹훅 핸들러가 AI 작업을 별도 invocation 으로 넘길 때 쓴다 (`X-Internal-Secret` 인증)                            |

승인·병합의 공통 규칙은 `utils/prActions.js` 에 있다. 요약하면 Week 가 다르거나 Status 가 `Solving` 인 PR, Draft PR 은 건너뛰고, 승인은 CI 가 통과한 PR 에만, 병합은 승인 리뷰가 있고 `mergeable_state` 가 `clean` 인 PR 에만 한다.

`/resolve-iteration` 이 있는 이유: Actions 의 기본 `GITHUB_TOKEN` 은 org 프로젝트 보드를 읽지 못해서(`read:project` 없음) App 토큰을 가진 이 Worker 가 대신 읽는다. 주차는 보드의 Week(Iteration) 필드에서 오므로 하드코딩하지 않는다.

## 웹훅

`handlers/webhooks.js` 가 leetcode-study 저장소의 이벤트만 처리한다.

| 이벤트                                                     | 하는 일                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `projects_v2_item`                                         | Week 설정이 바뀌면 경고 댓글을 달거나 지운다                                                 |
| `pull_request` (`opened`, `reopened`, `synchronize`)       | Week 검사, AI 풀이 분석 check run(`tagPatterns`), 학습 현황 댓글(`postLearningStatus`)       |
| `issue_comment`, `pull_request_review_comment` (`created`) | `@dalestudy` 멘션에 응답한다. `approve`·`승인` 이면 PR 을 승인하고, 그 밖에는 AI 리뷰를 단다 |

Week 검사는 제목이 `WEEK NN Solutions` 형태인 풀이 PR 만 대상으로 하고, 경고 댓글은 봇이 단 것만 지운다.

### AI 작업을 별도 invocation 으로 나누기

Worker 한 번의 실행(invocation)은 subrequest 를 50 개까지 쓸 수 있다. 파일이 많은 PR 에서 넘치지 않도록, 웹훅 핸들러는 두 AI 작업을 자기 자신에게 다시 요청해 따로 실행한다.

```
GitHub webhook
   ▼
[#1] webhook 핸들러                       ← 50 예산
   ├─ ctx.waitUntil(fetch("/internal/tag-patterns"))     → [#2] tagPatterns          ← 독립 50 예산
   └─ ctx.waitUntil(fetch("/internal/learning-status"))  → [#3] postLearningStatus   ← 독립 50 예산
```

`INTERNAL_SECRET` 과 `WORKER_URL` 이 둘 다 있어야 켜진다. 하나라도 없으면 같은 invocation 에서 차례로 실행된다.
`tests/subrequest-budget.test.js` 가 fetch 횟수(`tagPatterns` 파일 15 개에 37, `postLearningStatus` 파일 5 개에 31)를 회귀 테스트로 고정한다.

## 배포와 시크릿

`main` 에 머지되면 GitHub Actions(`.github/workflows/deploy.yml`)가 테스트 후 GitHub secret 을 Worker secret 으로 넣으며 배포한다. PR 에서는 `integration.yaml` 이 테스트만 돈다. 웹훅을 받는 서버라 PR 미리보기는 두지 않는다.

| Worker 에서 읽는 이름  | 어디서 오나                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `APP_ID`, `WORKER_URL` | `wrangler.jsonc` 의 `vars` (공개 값)                                                |
| `PRIVATE_KEY`          | GitHub org secret `APP_PRIVATE_KEY`                                                 |
| `AI`                   | `wrangler.jsonc` 의 AI 바인딩. 같은 계정의 AI Gateway `dalestudy` 를 토큰 없이 부른다 |
| `INTERNAL_SECRET`      | GitHub 저장소 secret `INTERNAL_SECRET`                                              |
| `WEBHOOK_SECRET`       | GitHub 저장소 secret `WEBHOOK_SECRET`. GitHub App 웹훅 설정의 secret 과 같은 값이다 |

GitHub secret 은 배포할 때마다 Worker secret 으로 들어가므로 `wrangler secret put` 으로 따로 바꾸지 않는다. 다음 배포 때 GitHub 값으로 덮인다.
로컬에서는 `.dev.vars` 에 같은 이름으로 넣는다. `.dev.vars`, `*.pem` 은 커밋하지 않는다.

OpenAI 키는 Worker 에 두지 않는다. AI Gateway `dalestudy` 의 Provider Keys(BYOK)에 저장돼 있고, 게이트웨이는 BYOK only 라 키가 없으면 Unified Billing 으로 넘어가지 않고 실패한다. AI 바인딩은 `wrangler dev` 에서도 원격 게이트웨이를 부르므로 `wrangler login` 이 dalestudy 계정에 되어 있어야 한다.

## GitHub App 설정

https://github.com/organizations/DaleStudy/settings/apps/dalestudy

- Webhook URL: `https://github.dalestudy.com/webhooks`, Webhook secret 은 저장소 secret `WEBHOOK_SECRET` 과 같은 값. `/webhooks` 는 서명(`X-Hub-Signature-256`)이 맞지 않거나 `WEBHOOK_SECRET` 이 없으면 받지 않는다
- Repository permissions: Checks(Read & write), Contents(Read), Issues(Read & write), Metadata(Read), Pull requests(Read & write), Projects(Read & write)
- 이벤트: Issue comments, Pull request review comments, Projects v2 item, Pull requests
- DaleStudy 조직에 설치돼 있고 leetcode-study 에 접근할 수 있어야 한다

## 테스트

테스트는 대상 파일 옆에 `*.test.js` 로 둔다. `vitest` 의 `describe`·`it`·`expect`·`vi` 를 쓰고, 외부 모듈은 `vi.mock()`, `fetch` 는 `globalThis.fetch = vi.fn()` 으로 바꾼다. Worker runtime 과 바인딩이 필요한 테스트는 `cloudflare:test`, `cloudflare:workers` 를 쓴다 (`@cloudflare/vitest-pool-workers` 가 `wrangler.jsonc` 를 읽는다).

```javascript
vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
}));
```

## 주의사항

- **Workers 런타임이다.** Node.js 모듈과 Octokit 같은 npm 패키지는 대부분 동작하지 않는다. `fetch` 와 Web Crypto API 로 직접 구현한다. Private Key 는 PKCS8, PKCS1 모두 받는다 (`utils/github.js`).
- **GraphQL 쿼리에 값을 문자열로 직접 끼워 넣는다.** GraphQL 변수 문법을 쓰지 않으므로 입력값 검증을 빠뜨리지 않는다.
- **댓글 숨김 마커(`<!-- xxx-data: ... -->`)의 직렬화 형식을 바꿀 때는** 정규식, 문서 주석, 테스트를 같은 PR 에서 함께 고친다. 파싱이 빈 값으로 fallback 하면 회귀가 조용히 묻힌다.
- 응답에는 CORS 헤더(`Access-Control-Allow-Origin: *`)가 붙고, 에러는 500 으로 돌려준다. 원인은 `wrangler tail` 로 본다.
- 401 이 나면 `APP_ID` 와 `PRIVATE_KEY` 가 같은 App 의 것인지 확인한다.

## Code Review Rules

- Node.js 내장 모듈이나 Octokit 같은 Workers 런타임에서 동작하지 않는 패키지를 쓰면 지적한다.
- GraphQL 쿼리에 문자열로 끼워 넣는 값은 반드시 검증되어야 한다. 사용자 입력(PR 제목, 댓글 등)이 검증 없이 들어가면 심각한 문제로 지적한다.
- 새 엔드포인트는 기존처럼 `repo_owner`가 `DaleStudy`가 아니면 403을 돌려야 하고, `/internal/*`는 `X-Internal-Secret`을 검사해야 한다.
- `tagPatterns`나 `postLearningStatus`에 fetch가 늘어나면 `tests/subrequest-budget.test.js`의 고정값도 함께 갱신되어야 한다.
- 댓글 숨김 마커(`<!-- xxx-data: ... -->`) 형식을 바꾸면 파싱 정규식과 테스트도 같은 PR에서 바뀌어야 한다.
- 새 시크릿을 `wrangler secret put` 전제로 추가하면 지적한다. 시크릿은 GitHub secret으로 두고 배포 워크플로가 넣는다.
