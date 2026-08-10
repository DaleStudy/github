import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  shiftDate,
  parseCohort,
  parseWeek,
  findCoveringIteration,
  fetchCohortProjects,
} from "./iterations.js";

const APP_TOKEN = "fake-app-token";

function weekField(iterations, completedIterations) {
  return {
    name: "Week",
    configuration: { iterations, completedIterations },
  };
}

function iteration(title, startDate) {
  return { title, startDate, duration: 7 };
}

describe("shiftDate", () => {
  it("일 단위로 날짜를 이동한다", () => {
    expect(shiftDate("2026-08-02", 6)).toBe("2026-08-08");
    expect(shiftDate("2026-08-09", -1)).toBe("2026-08-08");
  });

  it("월·연 경계를 넘는다", () => {
    expect(shiftDate("2026-08-30", 6)).toBe("2026-09-05");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("parseCohort", () => {
  it("리트코드 스터디 보드에서 기수를 뽑는다", () => {
    expect(parseCohort("리트코드 스터디 8기")).toBe(8);
    expect(parseCohort("리트코드 스터디 11기")).toBe(11);
  });

  it("다른 보드는 null을 돌려준다", () => {
    expect(parseCohort("리트코드 스터디 템플릿")).toBeNull();
    expect(parseCohort("AI 스터디")).toBeNull();
    expect(parseCohort("AI 프로젝트 1기")).toBeNull();
    expect(parseCohort(undefined)).toBeNull();
  });
});

describe("parseWeek", () => {
  it("Week 제목에서 주차를 뽑는다", () => {
    expect(parseWeek("Week 1")).toBe(1);
    expect(parseWeek("Week 15")).toBe(15);
  });

  it("형식이 다르면 null을 돌려준다", () => {
    expect(parseWeek("Week 7(current)")).toBeNull();
    expect(parseWeek("Sprint 3")).toBeNull();
    expect(parseWeek(null)).toBeNull();
  });
});

describe("findCoveringIteration", () => {
  const projects = [
    {
      number: 29,
      title: "리트코드 스터디 8기",
      cohort: 8,
      iterations: [iteration("Week 7", "2026-08-02"), iteration("Week 6", "2026-07-26")],
    },
  ];

  it("주차 마지막 날(토요일)을 그 주차로 판정한다", () => {
    const found = findCoveringIteration(projects, "2026-08-08");

    expect(found).toMatchObject({
      cohort: 8,
      week: 7,
      weekLabel: "Week 7",
      startDate: "2026-08-02",
      endDate: "2026-08-08",
    });
  });

  it("주차 첫 날(일요일)도 그 주차로 판정한다", () => {
    expect(findCoveringIteration(projects, "2026-08-02")).toMatchObject({ week: 7 });
  });

  it("직전 주차는 직전 iteration으로 판정한다", () => {
    expect(findCoveringIteration(projects, "2026-07-26")).toMatchObject({ week: 6 });
  });

  it("어느 주차에도 속하지 않으면 null을 돌려준다", () => {
    expect(findCoveringIteration(projects, "2026-08-09")).toBeNull();
    expect(findCoveringIteration(projects, "2026-07-25")).toBeNull();
  });

  it("기수가 바뀌어도 날짜로 기수와 주차를 함께 판정한다", () => {
    const acrossCohorts = [
      {
        number: 30,
        title: "리트코드 스터디 9기",
        cohort: 9,
        iterations: [iteration("Week 1", "2026-10-18")],
      },
      {
        number: 29,
        title: "리트코드 스터디 8기",
        cohort: 8,
        iterations: [iteration("Week 15", "2026-09-27")],
      },
    ];

    expect(findCoveringIteration(acrossCohorts, "2026-10-03")).toMatchObject({
      cohort: 8,
      week: 15,
    });
    expect(findCoveringIteration(acrossCohorts, "2026-10-24")).toMatchObject({
      cohort: 9,
      week: 1,
    });
    // 기수 사이 휴식기
    expect(findCoveringIteration(acrossCohorts, "2026-10-10")).toBeNull();
  });

  it("Week 형식이 아닌 iteration은 무시한다", () => {
    const odd = [
      {
        number: 29,
        title: "리트코드 스터디 8기",
        cohort: 8,
        iterations: [iteration("오리엔테이션", "2026-08-02")],
      },
    ];

    expect(findCoveringIteration(odd, "2026-08-05")).toBeNull();
  });
});

describe("fetchCohortProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockProjects(nodes) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ data: { organization: { projectsV2: { nodes } } } }),
    });
  }

  it("완료된 주차와 남은 주차를 하나로 합친다", async () => {
    mockProjects([
      {
        number: 29,
        title: "리트코드 스터디 8기",
        fields: {
          nodes: [
            weekField(
              [iteration("Week 8", "2026-08-09")],
              [iteration("Week 7", "2026-08-02")]
            ),
          ],
        },
      },
    ]);

    const projects = await fetchCohortProjects(APP_TOKEN);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ number: 29, cohort: 8 });
    expect(projects[0].iterations.map((it) => it.title)).toEqual([
      "Week 8",
      "Week 7",
    ]);
  });

  it("리트코드 스터디 보드가 아니거나 Week 필드가 없으면 제외한다", async () => {
    mockProjects([
      {
        number: 35,
        title: "AI 스터디",
        fields: { nodes: [weekField([iteration("Week 1", "2026-08-02")], [])] },
      },
      {
        number: 30,
        title: "리트코드 스터디 9기",
        fields: { nodes: [{ name: "Status" }] },
      },
      {
        number: 15,
        title: "리트코드 스터디 템플릿",
        fields: { nodes: [weekField([], [iteration("Week 1", "2024-08-11")])] },
      },
      {
        number: 29,
        title: "리트코드 스터디 8기",
        fields: { nodes: [weekField([], [iteration("Week 7", "2026-08-02")])] },
      },
    ]);

    const projects = await fetchCohortProjects(APP_TOKEN);

    expect(projects.map((project) => project.number)).toEqual([29]);
  });

  it("GraphQL 오류는 예외로 올린다", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errors: [{ message: "Bad credentials" }] }),
    });

    await expect(fetchCohortProjects(APP_TOKEN)).rejects.toThrow("GraphQL error");
  });
});
