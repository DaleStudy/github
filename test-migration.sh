#!/bin/bash
#
# Cloudflare 계정 이전 후 기능 검증 테스트
# Usage: ./test-migration.sh [BASE_URL]
#

BASE_URL="${1:-https://github.dalestudy.com}"
BASE_URL="${BASE_URL%/}"

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Counters ---
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# --- Helpers ---
pass() {
  echo -e "  ${GREEN}[PASS]${NC} $1"
  ((PASS_COUNT++))
}

fail() {
  echo -e "  ${RED}[FAIL]${NC} $1"
  [ -n "$2" ] && echo -e "        $2"
  ((FAIL_COUNT++))
}

skip() {
  echo -e "  ${YELLOW}[SKIP]${NC} $1"
  ((SKIP_COUNT++))
}

section() {
  echo ""
  echo -e "${CYAN}=== $1 ===${NC}"
}

# --- Prereq ---
if ! command -v curl &>/dev/null; then
  echo "curl이 설치되어 있지 않습니다."
  exit 1
fi

echo ""
echo "Target: $BASE_URL"

# ============================================================
# Tier 1: Connectivity & Routing
# ============================================================
section "Tier 1: Connectivity & Routing"

# 1.1 CORS preflight
HEADERS=$(curl -s -D- -o /dev/null -X OPTIONS "$BASE_URL/check-weeks" --max-time 30 2>/dev/null)
if echo "$HEADERS" | grep -qi "Access-Control-Allow-Origin"; then
  pass "1.1 CORS preflight"
else
  fail "1.1 CORS preflight" "Access-Control-Allow-Origin 헤더 없음"
fi

# 1.2 GET 차단 (405)
BODY=$(curl -s -w '\n%{http_code}' -X GET "$BASE_URL/check-weeks" --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "405" ] && echo "$BODY_CONTENT" | grep -q "Method not allowed"; then
  pass "1.2 GET -> 405 Method Not Allowed"
else
  fail "1.2 GET -> 405 Method Not Allowed" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.3 없는 경로 (404)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/nonexistent-path" \
  -H "Content-Type: application/json" -d '{}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "404" ] && echo "$BODY_CONTENT" | grep -q "Not found"; then
  pass "1.3 POST /nonexistent -> 404"
else
  fail "1.3 POST /nonexistent -> 404" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.4 조직 검증 (403)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/check-weeks" \
  -H "Content-Type: application/json" \
  -d '{"repo_owner":"FakeOrg","repo_name":"leetcode-study"}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "403" ] && echo "$BODY_CONTENT" | grep -q "Unauthorized"; then
  pass "1.4 check-weeks 조직 검증 -> 403"
else
  fail "1.4 check-weeks 조직 검증 -> 403" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.5 필수 필드 누락 (400)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/check-weeks" \
  -H "Content-Type: application/json" -d '{}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "400" ] && echo "$BODY_CONTENT" | grep -q "Missing required field"; then
  pass "1.5 check-weeks 필수 필드 누락 -> 400"
else
  fail "1.5 check-weeks 필수 필드 누락 -> 400" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.6 approve-prs week 누락 (400)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/approve-prs" \
  -H "Content-Type: application/json" \
  -d '{"repo_name":"leetcode-study"}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "400" ] && echo "$BODY_CONTENT" | grep -q "week"; then
  pass "1.6 approve-prs week 누락 -> 400"
else
  fail "1.6 approve-prs week 누락 -> 400" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.7 merge-prs week 누락 (400)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/merge-prs" \
  -H "Content-Type: application/json" \
  -d '{"repo_name":"leetcode-study"}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')
if [ "$STATUS" = "400" ] && echo "$BODY_CONTENT" | grep -q "week"; then
  pass "1.7 merge-prs week 누락 -> 400"
else
  fail "1.7 merge-prs week 누락 -> 400" "status=$STATUS, body=$BODY_CONTENT"
fi

# 1.8 경로 별칭 (underscore)
BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/approve_prs" \
  -H "Content-Type: application/json" \
  -d '{"repo_name":"leetcode-study"}' --max-time 30 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
if [ "$STATUS" = "400" ]; then
  pass "1.8 /approve_prs 경로 별칭 라우팅"
else
  fail "1.8 /approve_prs 경로 별칭 라우팅" "status=$STATUS (expected 400)"
fi

# ============================================================
# Tier 2: GitHub App 인증 & check-weeks
# ============================================================
section "Tier 2: GitHub App 인증 (check-weeks)"

echo -e "  ${YELLOW}(PR 수에 따라 최대 60초 소요)${NC}"

BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/check-weeks" \
  -H "Content-Type: application/json" \
  -d '{"repo_name":"leetcode-study"}' --max-time 60 2>/dev/null)
STATUS=$(echo "$BODY" | tail -1)
BODY_CONTENT=$(echo "$BODY" | sed '$d')

# 2.1 성공 응답
if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q '"success":true'; then
  pass "2.1 check-weeks 성공 (GitHub App 인증 OK)"
else
  fail "2.1 check-weeks 성공" "status=$STATUS, body=$BODY_CONTENT"
fi

# 2.2 응답 구조 검증
FIELDS_OK=true
for field in total_prs checked results; do
  if ! echo "$BODY_CONTENT" | grep -q "\"$field\""; then
    FIELDS_OK=false
    break
  fi
done
if [ "$FIELDS_OK" = true ] && [ "$STATUS" = "200" ]; then
  pass "2.2 응답 구조 (total_prs, checked, results)"
else
  fail "2.2 응답 구조" "필드 누락: $BODY_CONTENT"
fi

# ============================================================
# Tier 3: Webhook 엔드포인트
# ============================================================
section "Tier 3: Webhook 엔드포인트"

# WEBHOOK_SECRET 감지
PROBE=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
  -H "Content-Type: application/json" -d '{}' --max-time 30 2>/dev/null)
PROBE_STATUS=$(echo "$PROBE" | tail -1)

if [ "$PROBE_STATUS" = "401" ]; then
  echo -e "  ${YELLOW}WEBHOOK_SECRET이 활성 상태입니다. 서명 없이 테스트 불가.${NC}"
  skip "3.1 미지원 이벤트 무시"
  skip "3.2 잘못된 조직 무시"
  skip "3.3 잘못된 저장소 무시"
  skip "3.4 미처리 액션 무시"
  skip "3.5 멘션 없는 댓글 무시"
  skip "3.6 PR 아닌 댓글 무시"
else
  # 3.1 미지원 이벤트
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: ping" \
    -d '{"organization":{"login":"DaleStudy"},"repository":{"name":"leetcode-study"}}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "Ignored"; then
    pass "3.1 ping 이벤트 -> Ignored"
  else
    fail "3.1 ping 이벤트 -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi

  # 3.2 잘못된 조직
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: pull_request" \
    -d '{"organization":{"login":"FakeOrg"}}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "not DaleStudy"; then
    pass "3.2 잘못된 조직 -> Ignored"
  else
    fail "3.2 잘못된 조직 -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi

  # 3.3 잘못된 저장소
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: pull_request" \
    -d '{"organization":{"login":"DaleStudy"},"repository":{"name":"other-repo"}}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "other-repo"; then
    pass "3.3 잘못된 저장소 -> Ignored"
  else
    fail "3.3 잘못된 저장소 -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi

  # 3.4 미처리 액션 (closed)
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: pull_request" \
    -d '{"organization":{"login":"DaleStudy"},"repository":{"name":"leetcode-study"},"action":"closed"}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "Ignored"; then
    pass "3.4 pull_request closed -> Ignored"
  else
    fail "3.4 pull_request closed -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi

  # 3.5 멘션 없는 댓글
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: issue_comment" \
    -d '{"organization":{"login":"DaleStudy"},"repository":{"name":"leetcode-study","owner":{"login":"DaleStudy"}},"action":"created","comment":{"body":"just a regular comment","id":1},"issue":{"number":1,"pull_request":{"url":"https://api.github.com/repos/DaleStudy/leetcode-study/pulls/1"}}}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "not mentioned"; then
    pass "3.5 멘션 없는 댓글 -> Ignored"
  else
    fail "3.5 멘션 없는 댓글 -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi

  # 3.6 PR 아닌 이슈 댓글
  BODY=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/webhooks" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: issue_comment" \
    -d '{"organization":{"login":"DaleStudy"},"repository":{"name":"leetcode-study","owner":{"login":"DaleStudy"}},"action":"created","comment":{"body":"@dalestudy review","id":1},"issue":{"number":1}}' \
    --max-time 30 2>/dev/null)
  STATUS=$(echo "$BODY" | tail -1)
  BODY_CONTENT=$(echo "$BODY" | sed '$d')
  if [ "$STATUS" = "200" ] && echo "$BODY_CONTENT" | grep -q "not a PR comment"; then
    pass "3.6 이슈 댓글 (PR 아님) -> Ignored"
  else
    fail "3.6 이슈 댓글 (PR 아님) -> Ignored" "status=$STATUS, body=$BODY_CONTENT"
  fi
fi

# ============================================================
# Tier 4: 수동 검증 안내
# ============================================================
section "Tier 4: 수동 검증 (아래 명령을 직접 실행하세요)"

echo ""
echo -e "  ${YELLOW}[approve-prs]${NC} PR 일괄 승인 (Week 번호를 실제 값으로 변경)"
echo "  curl -X POST $BASE_URL/approve-prs \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"repo_name\":\"leetcode-study\",\"week\":\"Week 14\"}'"

echo ""
echo -e "  ${YELLOW}[merge-prs]${NC} PR 일괄 병합"
echo "  curl -X POST $BASE_URL/merge-prs \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"repo_name\":\"leetcode-study\",\"week\":\"Week 14\",\"merge_method\":\"squash\"}'"

echo ""
echo -e "  ${YELLOW}[Webhook]${NC} 실제 이벤트로 검증"
echo "  1. wrangler tail  (로그 모니터링 시작)"
echo "  2. leetcode-study에서 PR 생성/재오픈 -> Week 경고 댓글 확인"
echo "  3. PR 댓글에 '@dalestudy review' 작성 -> AI 리뷰 확인"
echo "  4. PR 댓글에 '@dalestudy approve' 작성 -> 자동 승인 확인"
echo "  5. 코드 라인 댓글에 '@dalestudy' 작성 -> 스레드 답변 확인"

# ============================================================
# Summary
# ============================================================
echo ""
echo "=========================================="
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo -e "  결과: ${GREEN}${PASS_COUNT} passed${NC}, ${RED}${FAIL_COUNT} failed${NC}, ${YELLOW}${SKIP_COUNT} skipped${NC} / $TOTAL total"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "  ${RED}EXIT: 1 (실패한 테스트 있음)${NC}"
  echo "=========================================="
  exit 1
else
  echo -e "  ${GREEN}EXIT: 0 (모든 테스트 통과)${NC}"
  echo "=========================================="
  exit 0
fi
