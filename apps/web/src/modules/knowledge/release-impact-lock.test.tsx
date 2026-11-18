import { beforeEach, describe, expect, it, vi } from "vitest";

// The web tests have no DOM, so a click cannot be simulated. This drives the
// real `useMutation` lock (with React's state hooks reduced to plain values)
// through `runAfterReleaseCheck`, exactly as the knowledge call sites do:
// `runAfterReleaseCheck(mutation.run, projectId, locale, () => action(...))`.
const state: { error: unknown[]; success: unknown[] } = {
  error: [],
  success: [],
};
let hook = 0;
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    // useMutation's order: pending, error, success.
    const slot = ["pending", "error", "success"][hook++ % 3]!;
    return [
      initial,
      (next: unknown) => {
        if (slot === "error" || slot === "success") state[slot].push(next);
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
}));

// The release-impact check: held open until the test answers it.
let answer: (value: unknown) => void = () => {};
const checks: string[] = [];
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: (path: string) => {
    checks.push(path);
    return new Promise((resolve) => {
      answer = resolve;
    });
  },
}));

import { useMutation } from "@/lib/api";
import { runAfterReleaseCheck } from "./release-impact";

const blocking = {
  enabled: true,
  gateValid: true,
  count: 2,
  dependents: [],
};

beforeEach(() => {
  hook = 0;
  checks.length = 0;
  state.error = [];
  state.success = [];
});

describe("runAfterReleaseCheck inside the mutation lock", () => {
  it("a second trigger while the first check is pending sends nothing", async () => {
    const onSuccess = vi.fn();
    const mutation = useMutation(onSuccess);
    const action = vi.fn(async () => ({ id: "s1" }));
    const ask = vi.fn(() => true);
    const first = runAfterReleaseCheck(mutation.run, "proj", "de", action, ask);
    // Double click: the lock is held during the check and the question.
    const second = runAfterReleaseCheck(
      mutation.run,
      "proj",
      "de",
      action,
      ask,
    );
    expect(await second).toBeUndefined();
    expect(checks).toHaveLength(1);
    answer(blocking);
    expect(await first).toEqual({ id: "s1" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // The lock is free again afterwards.
    const third = runAfterReleaseCheck(mutation.run, "proj", "de", action, ask);
    answer(blocking);
    await third;
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("a cancel sends no request and shows no error or success", async () => {
    const onSuccess = vi.fn();
    const mutation = useMutation(onSuccess);
    const action = vi.fn(async () => ({ id: "s1" }));
    const pending = runAfterReleaseCheck(
      mutation.run,
      "proj",
      "en",
      action,
      () => false,
    );
    answer(blocking);
    expect(await pending).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(state.error.filter((e) => e !== null)).toEqual([]);
    expect(state.success.filter((s) => s === true)).toEqual([]);
  });

  it("a failed action still shows its error", async () => {
    const mutation = useMutation();
    const pending = runAfterReleaseCheck(
      mutation.run,
      "proj",
      "en",
      async () => {
        throw new Error("SOURCE_NOT_FOUND");
      },
      () => true,
    );
    answer(blocking);
    expect(await pending).toBeUndefined();
    expect(state.error).toContain("SOURCE_NOT_FOUND");
  });
});
