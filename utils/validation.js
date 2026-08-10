/**
 * 검증 로직 유틸리티
 */

import { ALLOWED_ORG } from "./constants.js";

// "[dale] WEEK 07 Solutions" 같은 풀이 제출 PR 제목.
// 제목 규칙이 강제되지 않아 "Solutions"를 빼먹는 PR이 있으므로 주차만 확인한다.
const SOLUTION_TITLE_PATTERN = /week\s*\d+/i;

/**
 * Organization 검증
 */
export function validateOrganization(orgName) {
  return orgName === ALLOWED_ORG;
}

/**
 * 풀이 제출 PR인지 제목으로 판별
 *
 * 봇 테스트나 저장소 정리 PR을 Week 경고 댓글 대상에서 제외한다. 프로젝트
 * 연결 여부는 참가자가 PR을 올린 뒤 직접 설정해서 갓 올라온 PR일수록 비어
 * 있으므로 판별에 쓸 수 없다.
 */
export function isSolutionPR(title) {
  return SOLUTION_TITLE_PATTERN.test(title ?? "");
}

/**
 * PR 상태가 closed인지 확인
 */
export function isClosedPR(prState) {
  return prState === "closed";
}
