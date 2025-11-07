/**
 * 검증 로직 유틸리티
 */

import { ALLOWED_ORG, MAINTENANCE_LABEL } from "./constants.js";

/**
 * Organization 검증
 */
export function validateOrganization(orgName) {
  return orgName === ALLOWED_ORG;
}

/**
 * maintenance 라벨이 있는 PR인지 확인
 */
export function hasMaintenanceLabel(labels) {
  return labels.includes(MAINTENANCE_LABEL);
}

/**
 * PR 상태가 closed인지 확인
 */
export function isClosedPR(prState) {
  return prState === "closed";
}
