import { describe, expect, it } from "vitest";
import { apiQuery, searchFromState, stateFromSearch } from "./query";

// The calendar's state lives in the URL (S6): shareable, back/forward work.

const ID = "11111111-1111-4111-8111-111111111111";

describe("calendar query", () => {
  it("defaults to this month in the project and ignores unknown values", () => {
    expect(stateFromSearch(new URLSearchParams("view=year&anchor=2026-13-01&platforms=myspace,x&accounts=nope"), "2026-11-03")).toEqual({
      view: "month",
      anchor: "2026-11-03",
      scope: "project",
      accountIds: [],
      platforms: ["x"],
      statuses: [],
      origins: [],
      projectIds: [],
    });
  });

  it("writes a stable search that reads back the same", () => {
    const state = stateFromSearch(
      new URLSearchParams(`origins=manual&view=week&anchor=2026-11-20&scope=organization&projects=${ID}&statuses=scheduled,draft&accounts=${ID}`),
      "2026-11-03",
    );
    const search = searchFromState(state);
    expect(search).toBe(`view=week&anchor=2026-11-20&scope=organization&accounts=${ID}&statuses=scheduled%2Cdraft&origins=manual&projects=${ID}`);
    expect(stateFromSearch(new URLSearchParams(search), "2026-11-03")).toEqual(state);
    expect(searchFromState(stateFromSearch(new URLSearchParams(""), "2026-11-03"))).toBe("anchor=2026-11-03");
  });

  it("asks the server for the range and filters, projects only in the organization scope", () => {
    const state = stateFromSearch(new URLSearchParams(`platforms=x,telegram&projects=${ID}`), "2026-11-03");
    const range = { from: "2026-11-01T23:00:00.000Z", to: "2026-11-08T23:00:00.000Z" };
    expect(apiQuery(state, range)).toBe(`from=2026-11-01T23%3A00%3A00.000Z&to=2026-11-08T23%3A00%3A00.000Z&platforms=x%2Ctelegram`);
    expect(apiQuery({ ...state, scope: "organization" }, range)).toContain(`projectIds=${ID}`);
  });
});
