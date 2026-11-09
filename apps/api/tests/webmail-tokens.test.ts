import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleToken,
  handoffToken,
  verifyHandle,
  verifyHandoff,
} from "../src/modules/webmail/tokens.ts";

const claims = () => ({
  workspaceId: randomUUID(),
  projectId: randomUUID(),
  sessionId: randomUUID(),
});
const inAMinute = () => new Date(Date.now() + 60_000);

/** Webmail tokens (ADR 0026): forgeries die here, before any database access. */
describe("webmail tokens", () => {
  it("carries the workspace, project and session ids", () => {
    const expected = claims();
    expect(verifyHandoff(handoffToken(expected, inAMinute()))).toEqual({
      status: "ok",
      claims: expected,
    });
    expect(verifyHandle(handleToken(expected, inAMinute()))).toEqual({
      status: "ok",
      claims: expected,
    });
  });

  it("refuses a handoff used as a handle and the reverse (labels of their own)", () => {
    const expected = claims();
    expect(verifyHandle(handoffToken(expected, inAMinute())).status).toBe(
      "invalid",
    );
    expect(verifyHandoff(handleToken(expected, inAMinute())).status).toBe(
      "invalid",
    );
  });

  it("refuses a changed id or expiry", () => {
    const token = handoffToken(claims(), inAMinute());
    const [ids, expires, mac] = token.split(".") as [string, string, string];
    const other = handoffToken(claims(), inAMinute()).split(".")[0]!;
    expect(verifyHandoff(`${other}.${expires}.${mac}`).status).toBe("invalid");
    expect(verifyHandoff(`${ids}.zzzzzz.${mac}`).status).toBe("invalid");
  });

  it("reports an authentic but outdated token as expired", () => {
    const token = handoffToken(claims(), new Date(Date.now() - 1_000));
    expect(verifyHandoff(token).status).toBe("expired");
  });

  it.each(["", "a.b", "a.b.c.d", "ü.b.c", "x".repeat(401)])(
    "refuses the malformed token %#",
    (token) => {
      expect(verifyHandoff(token).status).toBe("invalid");
      expect(verifyHandle(token).status).toBe("invalid");
    },
  );

  it("fits the 400 characters of the bridge contract", () => {
    expect(handleToken(claims(), inAMinute()).length).toBeLessThan(400);
  });
});
