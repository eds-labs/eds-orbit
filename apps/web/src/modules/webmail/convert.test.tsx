import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  convertClient,
  endSession,
  settingsApi,
  type ConvertTarget,
} from "./api";
import {
  convertErrorKey,
  createConvertSubmitter,
  initialForm,
  loadConvertStage,
  modeOf,
  POLL_DELAYS_MS,
  recordHref,
  runConvert,
  withDestination,
  type ConvertForm,
  type ConvertRun,
} from "./convert";
import {
  ConvertFormView,
  ConvertResultView,
  ConvertStageView,
  RecordPickerView,
} from "./convert-dialog";
import { webmailText } from "./labels";

const t = webmailText("en");
const reference = { folder: "INBOX", uid: 12, uidValidity: 99 };
const target: ConvertTarget = {
  key: "support.ticket",
  label: "Support ticket",
  destinations: [
    { id: "d1", name: "Help", address: "help@example.com", categories: ["billing"], priorities: ["low", "high"] },
    { id: "d2", name: "Sales", address: null, categories: [], priorities: ["normal"] },
  ],
};
const done = {
  status: "done" as const,
  target: "support.ticket",
  recordId: "t1",
  number: 42,
  duplicate: false,
  skippedAttachments: 2,
};

describe("loadConvertStage", () => {
  const client = (options: () => Promise<any>, status: () => Promise<any>) =>
    ({ options, status }) as never;
  const targets = async () => ({ targets: [target] });
  const open = async () => ({ converted: false });

  it("offers the form for a message not yet taken over", async () => {
    expect(await loadConvertStage(client(targets, open), reference)).toEqual({
      kind: "form",
      targets: [target],
    });
  });

  it("says when the message was already taken over", async () => {
    const status = async () => ({ converted: true, target: "support.ticket", recordId: "t9", number: 7 });
    expect(await loadConvertStage(client(targets, status), reference)).toEqual({
      kind: "already",
      target: "support.ticket",
      recordId: "t9",
      number: 7,
    });
  });

  it("hides the option when no target is active", async () => {
    const stage = await loadConvertStage(client(async () => ({ targets: [] }), open), reference);
    expect(stage).toEqual({ kind: "hidden" });
  });

  it.each([403, 404])("hides the option when the member lacks the right (%i)", async (status) => {
    const denied = async () => {
      throw new ApiError("NO", status);
    };
    expect(await loadConvertStage(client(denied, open), reference)).toEqual({ kind: "hidden" });
  });

  it("shows an error when the check itself fails", async () => {
    const failed = async () => {
      throw new ApiError("WEBMAIL_MESSAGE_NOT_FOUND", 404);
    };
    expect(await loadConvertStage(client(targets, failed), reference)).toEqual({
      kind: "load_error",
      error: "messageGone",
    });
  });
});

describe("runConvert", () => {
  function run(over: Partial<ConvertRun> & { convert?: any; status?: any } = {}) {
    const convert = over.convert ?? vi.fn(async () => done);
    const status = over.status ?? vi.fn(async () => ({ converted: false }));
    const sleep = vi.fn(async () => undefined);
    const onWaiting = vi.fn();
    const config: ConvertRun = {
      client: { convert, status },
      reference,
      target: "support.ticket",
      mode: { kind: "append", recordId: "t1" },
      sleep,
      isCancelled: () => false,
      onWaiting,
      ...over,
    };
    return { config, convert, status, sleep, onWaiting };
  }

  it("returns the result of a finished takeover", async () => {
    const { config, status } = run();
    expect(await runConvert(config)).toEqual({ kind: "done", result: done });
    expect(status).not.toHaveBeenCalled();
  });

  it("polls with backoff on 202 and never posts twice", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ converted: false })
      .mockResolvedValueOnce({ converted: true, target: "support.ticket", recordId: "t5", number: 5 });
    const convert = vi.fn(async () => ({ status: "pending" }));
    const { config, sleep, onWaiting } = run({ convert, status });
    const outcome = await runConvert(config);
    expect(outcome).toEqual({
      kind: "done",
      result: { target: "support.ticket", recordId: "t5", number: 5, duplicate: false, skippedAttachments: null },
    });
    expect(convert).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]: any) => ms)).toEqual([POLL_DELAYS_MS[0], POLL_DELAYS_MS[1]]);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it("uses growing delays and gives up after a few tries", async () => {
    const convert = vi.fn(async () => ({ status: "pending" }));
    const { config, status, sleep } = run({ convert });
    expect(await runConvert(config)).toEqual({ kind: "still_running" });
    const delays = sleep.mock.calls.map(([ms]: any) => ms as number);
    expect(delays).toEqual([...POLL_DELAYS_MS]);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(status).toHaveBeenCalledTimes(POLL_DELAYS_MS.length);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the dialog closed", async () => {
    const convert = vi.fn(async () => ({ status: "pending" }));
    const { config, status } = run({ convert, isCancelled: () => true });
    expect(await runConvert(config)).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ["WEBMAIL_MESSAGE_NOT_FOUND", 404, "messageGone"],
    ["WEBMAIL_TARGET_UNAVAILABLE", 404, "targetUnavailable"],
    ["WEBMAIL_UID_VALIDITY_CHANGED", 409, "folderChanged"],
    ["WEBMAIL_MAILBOX_UNAVAILABLE", 409, "mailboxUnavailable"],
    ["WEBMAIL_MESSAGE_TOO_LARGE", 413, "tooLarge"],
  ])("turns %s into plain words", async (code, status, key) => {
    const convert = vi.fn(async () => {
      throw new ApiError(code, status);
    });
    const { config } = run({ convert });
    expect(await runConvert(config)).toEqual({ kind: "error", error: key });
    expect(t.convert.errors[key as "messageGone"]).not.toContain("_");
  });

  it("falls back by status for an unknown code", () => {
    expect(convertErrorKey(new ApiError("X", 404))).toBe("messageGone");
    expect(convertErrorKey(new ApiError("X", 409))).toBe("conflict");
    expect(convertErrorKey(new ApiError("X", 413))).toBe("tooLarge");
    expect(convertErrorKey(new ApiError("X", 403))).toBe("forbidden");
    expect(convertErrorKey(new Error("x"))).toBe("generic");
  });

  it("refuses a double submit while the first runs", async () => {
    let finish!: (value: typeof done) => void;
    const convert = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const { config } = run({ convert });
    const submit = createConvertSubmitter();
    const first = submit(config);
    expect(await submit(config)).toBeNull();
    finish(done);
    expect(await first).toEqual({ kind: "done", result: done });
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("allows a new submit after a failure", async () => {
    const convert = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("WEBMAIL_MAILBOX_UNAVAILABLE", 409))
      .mockResolvedValueOnce(done);
    const { config } = run({ convert });
    const submit = createConvertSubmitter();
    await submit(config);
    expect(await submit(config)).toEqual({ kind: "done", result: done });
  });
});

describe("requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  it("sends only the reference, the target and the choice", async () => {
    const fetchMock = vi.fn(async () => respond(200, done));
    vi.stubGlobal("fetch", fetchMock);
    await convertClient("p1", "m1").convert(reference, "support.ticket", {
      kind: "create",
      destinationId: "d1",
      customerAddress: "from",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/p1/webmail/mailboxes/m1/convert");
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
      "folder",
      "mode",
      "target",
      "uid",
      "uidValidity",
    ]);
  });

  it("reads a 202 as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(202, { status: "pending" })));
    const answer = await convertClient("p1", "m1").convert(reference, "support.ticket", {
      kind: "append",
      recordId: "t1",
    });
    expect(answer).toEqual({ status: "pending" });
  });

  it("accepts the 204 of ending a session", async () => {
    const fetchMock = vi.fn(async () => respond(204));
    vi.stubGlobal("fetch", fetchMock);
    await expect(endSession("p1", "m1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/p1/webmail/mailboxes/m1/session");
    expect(init.method).toBe("DELETE");
  });

  it("reports a failed delete with its code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(409, { error: { code: "WEBMAIL_MAILBOX_UNAVAILABLE" } })),
    );
    await expect(settingsApi.close("p1", "m1")).rejects.toMatchObject({
      code: "WEBMAIL_MAILBOX_UNAVAILABLE",
      status: 409,
    });
  });
});

describe("the form's logic", () => {
  const form = (over: Partial<ConvertForm> = {}) => ({ ...initialForm([target]), ...over });

  it("starts on a new ticket in the first inbox", () => {
    expect(form()).toMatchObject({ choice: "new", targetKey: "support.ticket", destinationId: "d1" });
  });

  it("starts on existing tickets when there is no inbox to create in", () => {
    expect(initialForm([{ ...target, destinations: [] }]).choice).toBe("existing");
  });

  it("omits what the member left empty", () => {
    expect(modeOf(form({ subject: "   " }))).toEqual({
      kind: "create",
      destinationId: "d1",
      customerAddress: "from",
    });
  });

  it("sends what the member chose", () => {
    expect(
      modeOf(form({ subject: " Refund ", priority: "high", category: "billing", customerAddress: "reply_to" })),
    ).toEqual({
      kind: "create",
      destinationId: "d1",
      subject: "Refund",
      priority: "high",
      category: "billing",
      customerAddress: "reply_to",
    });
  });

  it("needs a ticket to add to", () => {
    expect(modeOf(form({ choice: "existing" }))).toBeNull();
    expect(modeOf(form({ choice: "existing", recordId: "t1" }))).toEqual({ kind: "append", recordId: "t1" });
  });

  it("clears a priority and category the new inbox does not offer", () => {
    const next = withDestination(form({ priority: "high", category: "billing" }), target, "d2");
    expect(next).toMatchObject({ destinationId: "d2", priority: "", category: "" });
  });

  it("links to the existing Support route", () => {
    expect(recordHref("p 1", "support.ticket", "t/1")).toBe("/p/p%201/support/tickets?ticket=t%2F1");
    expect(recordHref("p1", "other.record", "x")).toBeNull();
  });
});

describe("the dialog's views", () => {
  const view = (over: Partial<Parameters<typeof ConvertFormView>[0]> = {}) =>
    renderToStaticMarkup(
      <ConvertFormView
        t={t}
        targets={[target]}
        form={initialForm([target])}
        pending={false}
        waiting={false}
        error={null}
        search={<span>picker</span>}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        {...over}
      />,
    );

  it("shows the address replies leave from", () => {
    const html = view();
    expect(html).toContain("Replies leave from: help@example.com");
    expect(html).toContain(t.convert.customerAddress);
    expect(html).toContain("High");
    expect(html).toContain("billing");
  });

  it("says when an inbox has no outgoing address", () => {
    const html = view({ form: { ...initialForm([target]), destinationId: "d2" } });
    expect(html).toContain(t.convert.repliesNone);
    expect(html).not.toContain(t.convert.category);
  });

  it("shows the search for an existing ticket", () => {
    const html = view({ form: { ...initialForm([target]), choice: "existing" } });
    expect(html).toContain("picker");
    expect(html).not.toContain(t.convert.inbox);
  });

  it("locks the form and the button while submitting", () => {
    const html = view({ pending: true });
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toContain(t.convert.working);
  });

  it("disables submit until the form is complete", () => {
    const html = view({ form: { ...initialForm([target]), choice: "existing" } });
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("says when it waits for another attempt, and shows errors in words", () => {
    expect(view({ waiting: true })).toContain(t.convert.waiting);
    expect(view({ error: t.convert.errors.tooLarge })).toContain("larger than 10 MB");
  });

  it("lists search results by number and title", () => {
    const html = renderToStaticMarkup(
      <RecordPickerView
        t={t}
        query="refund"
        records={[{ id: "t1", number: 7, title: "Refund request", status: "open" }]}
        searching={false}
        recordId=""
        onQuery={() => {}}
        onPick={() => {}}
      />,
    );
    expect(html).toContain("#7");
    expect(html).toContain("Refund request");
  });

  it("says when the search found nothing", () => {
    const html = renderToStaticMarkup(
      <RecordPickerView t={t} query="x" records={[]} searching={false} recordId="" onQuery={() => {}} onPick={() => {}} />,
    );
    expect(html).toContain(t.convert.searchNone);
  });

  const result = (over: Partial<typeof done> | { skippedAttachments: null } = {}) =>
    renderToStaticMarkup(
      <ConvertResultView t={t} projectId="p1" result={{ ...done, ...over }} onClose={() => {}} />,
    );

  it("shows the number, the skipped attachments and the link after success", () => {
    const html = result();
    expect(html).toContain("Ticket #42 created.");
    expect(html).toContain("2 attachments were skipped.");
    expect(html).toContain('href="/p/p1/support/tickets?ticket=t1"');
  });

  it("does not claim a count it does not have", () => {
    expect(result({ skippedAttachments: null })).not.toContain("skipped");
  });

  it("says when the message was already in a ticket", () => {
    expect(result({ duplicate: true })).toContain("already in ticket #42");
  });

  it("shows an existing takeover with a link to the ticket", () => {
    const html = renderToStaticMarkup(
      <ConvertStageView
        t={t}
        projectId="p1"
        stage={{ kind: "already", target: "support.ticket", recordId: "t9", number: 9 }}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(t.convert.already);
    expect(html).toContain(t.convert.openTicket);
    expect(html).toContain('href="/p/p1/support/tickets?ticket=t9"');
  });

  it("offers a retry when loading failed", () => {
    const html = renderToStaticMarkup(
      <ConvertStageView
        t={t}
        projectId="p1"
        stage={{ kind: "load_error", error: "generic" }}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(t.retry);
  });

  it("renders nothing while hidden or loading", () => {
    for (const stage of [{ kind: "hidden" }, { kind: "loading" }] as const) {
      expect(
        renderToStaticMarkup(
          <ConvertStageView t={t} projectId="p1" stage={stage} onRetry={() => {}} onClose={() => {}} />,
        ),
      ).toBe("");
    }
  });
});
