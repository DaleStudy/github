/**
 * 프로젝트 보드 Iteration 기반 기수/주차 해석
 *
 * 리트코드 스터디는 기수마다 프로젝트 보드를 새로 만들고, 보드의 Week 필드
 * (Iteration)가 주차 일정을 관리한다. 주차 번호를 어디에도 하드코딩하지 않고
 * 보드에서 읽으므로, 기수가 바뀌어도 별도 설정 없이 다음 기수로 넘어간다.
 */

import { getGitHubHeaders } from "./github.js";
import { ALLOWED_ORG } from "./constants.js";

const COHORT_TITLE_PATTERN = /^리트코드 스터디 (\d+)기$/;
const WEEK_TITLE_PATTERN = /^Week (\d+)$/;
const WEEK_FIELD_NAME = "Week";

/**
 * 날짜 문자열을 일 단위로 이동
 *
 * @param {string} date - YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 보드 제목에서 기수 번호 추출 ("리트코드 스터디 8기" → 8)
 *
 * @returns {number|null} 리트코드 스터디 보드가 아니면 null
 */
export function parseCohort(title) {
  const matched = COHORT_TITLE_PATTERN.exec(title ?? "");
  return matched ? Number(matched[1]) : null;
}

/**
 * Iteration 제목에서 주차 번호 추출 ("Week 7" → 7)
 *
 * @returns {number|null}
 */
export function parseWeek(title) {
  const matched = WEEK_TITLE_PATTERN.exec(title ?? "");
  return matched ? Number(matched[1]) : null;
}

/**
 * 주어진 날짜를 포함하는 iteration 탐색
 *
 * @param {Array} projects - { number, title, cohort, iterations } 목록
 * @param {string} date - YYYY-MM-DD
 * @returns {Object|null} 해당 날짜가 속한 주차 정보
 */
export function findCoveringIteration(projects, date) {
  for (const project of projects) {
    for (const iteration of project.iterations) {
      const week = parseWeek(iteration.title);
      if (week === null) {
        continue;
      }

      const endDate = shiftDate(iteration.startDate, iteration.duration - 1);
      if (date < iteration.startDate || date > endDate) {
        continue;
      }

      return {
        cohort: project.cohort,
        week,
        weekLabel: iteration.title,
        projectNumber: project.number,
        projectTitle: project.title,
        startDate: iteration.startDate,
        endDate,
      };
    }
  }

  return null;
}

/**
 * 리트코드 스터디 보드들의 Week iteration 목록 조회
 *
 * 완료된 주차는 completedIterations로 옮겨가므로 두 배열을 모두 합친다.
 *
 * @param {string} appToken
 * @returns {Promise<Array>} { number, title, cohort, iterations } 목록
 */
export async function fetchCohortProjects(appToken) {
  const query = `
    query($org: String!) {
      organization(login: $org) {
        projectsV2(first: 20, orderBy: { field: NUMBER, direction: DESC }) {
          nodes {
            number
            title
            fields(first: 50) {
              nodes {
                ... on ProjectV2IterationField {
                  name
                  configuration {
                    iterations { title startDate duration }
                    completedIterations { title startDate duration }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...getGitHubHeaders(appToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { org: ALLOWED_ORG } }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  const nodes = result.data?.organization?.projectsV2?.nodes ?? [];

  return nodes
    .map((project) => {
      const cohort = parseCohort(project.title);
      if (cohort === null) {
        return null;
      }

      const weekField = (project.fields?.nodes ?? []).find(
        (field) => field?.name === WEEK_FIELD_NAME
      );
      if (!weekField) {
        return null;
      }

      return {
        number: project.number,
        title: project.title,
        cohort,
        iterations: [
          ...(weekField.configuration?.iterations ?? []),
          ...(weekField.configuration?.completedIterations ?? []),
        ],
      };
    })
    .filter(Boolean);
}

/**
 * 특정 날짜가 속한 기수/주차 해석
 *
 * @param {string} appToken
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<Object|null>}
 */
export async function resolveIteration(appToken, date) {
  const projects = await fetchCohortProjects(appToken);
  return findCoveringIteration(projects, date);
}
