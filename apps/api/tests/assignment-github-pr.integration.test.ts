import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, encrypt, entity, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  assignmentHash,
  assignmentInput,
  confirmedDelivery,
  deliveryOf,
  proposeAssignment,
  setAssignmentStatus,
} from "../src/modules/agents/assignments.ts";
import {
  planAssignmentRuns,
  runProblems,
} from "../src/modules/agents/assignment-runs.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import { tomorrowMorning } from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Synthetic token; nothing in these tests talks to GitHub.
const TOKEN = "github_pat_synthetic_0123456789_ABCDEFGHIJ";

/** A blog assignment delivered as a GitHub pull request (R81). */
const blogContent = (connectorId: string) => ({
  name: "Monthly blog article",
  kind: "standing" as const,
  schedule: {
    rhythm: "daily" as const,
    weekdays: [],
    times: ["10:00"],
  },
  contentType: "blog" as const,
  channels: [connectorId],
  topicFrame: "Articles about AI-assisted trading for uLiquid Desk",
  image: false,
  styleAssetIds: [],
  monthlyBudgetMicros: 5_000_000,
  delivery: "github_pr" as const,
});

const issues = (value: unknown) => {
  const parsed = assignmentInput.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("github_pr delivery input (R81)", () => {
  it("allows it only for blog articles", () => {
    expect(issues(blogContent("c1"))).toEqual([]);
    expect(
      issues({ ...blogContent("c1"), contentType: "social" }),
    ).toContainEqual(
      "delivery: Only blog articles can be delivered as GitHub pull requests",
    );
    expect(
      issues({ ...blogContent("c1"), contentType: "newsletter" }),
    ).toContainEqual(
      "delivery: Only blog articles can be delivered as GitHub pull requests",
    );
  });

  it("needs exactly one blog target as its channel", () => {
    expect(issues({ ...blogContent("c1"), channels: ["c1", "c2"] })).toContain(
      "channels: A GitHub delivery has exactly one blog target",
    );
    expect(issues({ ...blogContent("c1"), channels: [] })).toContain(
      "channels: A GitHub delivery has exactly one blog target",
    );
  });

  it("refuses images, banners, formats and shared texts", () => {
    expect(issues({ ...blogContent("c1"), image: true })).toContain(
      "image: A GitHub delivery has no article images",
    );
    expect(
      issues({ ...blogContent("c1"), sharedAcrossChannels: true }),
    ).toEqual([
      "sharedAcrossChannels: Only social posts can share one text across channels",
    ]);
    expect(
      issues({
        ...blogContent("c1"),
        format: {
          minChars: 100,
          maxChars: 200,
          hashtags: { min: 0, max: 0 },
          paragraphs: true,
        },
      }),
    ).toEqual(["format: Only social posts have a format"]);
    expect(
      issues({ ...blogContent("c1"), image: true, banner: {} }).some((i) =>
        i.startsWith("banner"),
      ),
    ).toBe(true);
  });

  it("reads the delivery and hashes it", () => {
    const content = blogContent("c1");
    expect(deliveryOf(content)).toBe("github_pr");
    expect(assignmentHash(content)).not.toBe(
      assignmentHash({ ...content, delivery: "publish" }),
    );
    expect(
      confirmedDelivery({
        ...content,
        confirmation: { delivery: "github_pr", assignmentHash: "other" },
      }),
    ).toBe("github_pr");
    // A confirmation without a recorded delivery whose hash matches the row.
    expect(
      confirmedDelivery({
        ...content,
        confirmation: { assignmentHash: assignmentHash(content) },
      }),
    ).toBe("github_pr");
  });
});

describe.skipIf(!enabled)("github_pr assignments (R81)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const rows = (kind: string) =>
    run((tx) => list(tx, project.owner, kind)).then((found) =>
      found.map((row): Record<string, any> => ({ id: row.id, ...data(row) })),
    );
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const addConnector = (extra: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "connectors", {
        provider: "github",
        owner: "eds-labs",
        repo: "uliquid-desk-website-v2",
        baseBranch: "main",
        postsPath: "content/blog/posts",
        siteUrl: "https://uliquid.vip",
        blogPathPrefix: "/blog/",
        profile: "uliquid-blog-json-v1",
        tokenExpiresAt: "2027-01-31",
        encryptedCredential: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
        status: "write_verified",
        capabilities: [],
        ...extra,
      }),
    );
  const propose = async (content: Record<string, unknown>) => {
    const thread = await createConversation(project.editor);
    return proposeAssignment(project.editor, thread.id, content);
  };
  const confirm = (requestId: string) =>
    run(async (tx) => {
      const row = await entity(tx, project.owner, "action_requests", requestId);
      return decideActionRequest(tx, project.owner, requestId, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
      });
    });
  const assignmentOf = (id: string) =>
    run(async (tx) => data(await entity(tx, project.owner, "assignments", id)));

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_BLOG_GITHUB = "true";
    project = await createPackageProject();
    // The policy allows blog articles; its channels stay the social ones.
    const policy = (await rows("policies")).find((p) => p.active === true)!;
    await setPolicy({ contentTypes: [...policy.contentTypes, "blog"] });
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_BLOG_GITHUB;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("is refused while ORBIT_BLOG_GITHUB is off", async () => {
    const connector = await addConnector();
    process.env.ORBIT_BLOG_GITHUB = "false";
    await expect(propose(blogContent(connector.id))).rejects.toThrow(
      "BLOG_GITHUB_DISABLED",
    );
    expect(await rows("assignments")).toEqual([]);
  });

  it("needs a write-verified github connector as its channel", async () => {
    const configured = await addConnector({ status: "configured" });
    await expect(propose(blogContent(configured.id))).rejects.toThrow(
      "BLOG_TARGET_NOT_VERIFIED",
    );
    const read = await addConnector({ status: "read_verified" });
    await expect(propose(blogContent(read.id))).rejects.toThrow(
      "BLOG_TARGET_NOT_VERIFIED",
    );
    const postiz = await addConnector({ provider: "postiz" });
    await expect(propose(blogContent(postiz.id))).rejects.toThrow(
      "BLOG_TARGET_NOT_VERIFIED",
    );
    // A social channel id is no connector at all.
    await expect(propose(blogContent(X))).rejects.toThrow(
      "BLOG_TARGET_NOT_VERIFIED",
    );
    expect(await rows("assignments")).toEqual([]);
  });

  it("needs blog among the policy's content types, not the connector among its channels", async () => {
    const connector = await addConnector();
    const policy = (await rows("policies")).find((p) => p.active === true)!;
    expect(policy.channels).not.toContain(connector.id);
    const { assignment } = await propose(blogContent(connector.id));
    expect(data(assignment).delivery).toBe("github_pr");
    await setPolicy({
      contentTypes: policy.contentTypes.filter((t: string) => t !== "blog"),
    });
    await expect(propose(blogContent(connector.id))).rejects.toThrow(
      "SCOPE_NOT_ALLOWED",
    );
  });

  it("records github_pr with the owner's confirmation", async () => {
    const connector = await addConnector();
    const { assignment, actionRequest } = await propose(
      blogContent(connector.id),
    );
    await confirm(actionRequest.id);
    const active = await assignmentOf(assignment.id);
    expect(active.status).toBe("active");
    expect(active.confirmation.delivery).toBe("github_pr");
    expect(active.confirmation.assignmentHash).toBe(assignmentHash(active));
    expect(confirmedDelivery(active)).toBe("github_pr");
  });

  it("ends a run at its start with BLOG_GITHUB_DISABLED while the flag is off", async () => {
    const connector = await addConnector();
    const { assignment, actionRequest } = await propose(
      blogContent(connector.id),
    );
    await confirm(actionRequest.id);
    const before = await assignmentOf(assignment.id);
    process.env.ORBIT_BLOG_GITHUB = "false";
    await run((tx) => planAssignmentRuns(tx, project.owner, tomorrowMorning()));
    const runs = await rows("assignment_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      assignmentId: assignment.id,
      status: "failed",
      errorCode: "BLOG_GITHUB_DISABLED",
      slots: [],
      costMicros: 0,
    });
    expect(
      (runs[0]!.steps as Array<{ status: string }>).every(
        (step) => step.status === "canceled",
      ),
    ).toBe(true);
    expect(await rows("agent_tasks")).toEqual([]);
    // The assignment keeps its confirmation; a second sweep adds no run.
    const after = await assignmentOf(assignment.id);
    expect(after.status).toBe("active");
    expect(after.confirmation).toEqual(before.confirmation);
    await run((tx) => planAssignmentRuns(tx, project.owner, tomorrowMorning()));
    expect(await rows("assignment_runs")).toHaveLength(1);
  });
  const notices = async (kind: string) =>
    (await rows("jobs")).filter((job) =>
      String(job.idempotencyKey ?? "").startsWith(`notify:${kind}:`),
    );
  // A linked bot, so notices are queued as jobs.
  const linkBot = () =>
    run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status: "linked",
        chatId: "4711",
        linkedUserId: project.owner.userId,
        linkedAt: new Date().toISOString(),
      }),
    );
  const setConnector = (id: string, status: string) =>
    run(async (tx) => {
      const row = await entity(tx, project.owner, "connectors", id);
      await update(tx, project.owner, row, { ...data(row), status });
    });

  it("plans one run per due day with one slot on the connector, outside the social slot rules", async () => {
    await linkBot();
    const connector = await addConnector();
    const { assignment, actionRequest } = await propose({
      ...blogContent(connector.id),
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
      },
    });
    await confirm(actionRequest.id);
    const morning = tomorrowMorning();
    await run((tx) => planAssignmentRuns(tx, project.owner, morning));
    const runs = await rows("assignment_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      assignmentId: assignment.id,
      unavailable: [],
    });
    expect(runs[0]!.status).not.toBe("failed");
    const slots = runs[0]!.slots as Array<{ channel: string; at: string }>;
    expect(slots).toHaveLength(1);
    expect(slots[0]!.channel).toBe(connector.id);
    expect(Date.parse(slots[0]!.at)).toBeGreaterThan(morning.valueOf());
    expect((await rows("agent_tasks")).length).toBeGreaterThan(0);
    expect(await notices("slots_unavailable")).toEqual([]);
    expect(
      await run((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: project.owner.projectId,
            action: "assignment.day_skipped",
          },
        }),
      ),
    ).toEqual([]);
    // A second sweep the same day adds no second run.
    await run((tx) => planAssignmentRuns(tx, project.owner, morning));
    expect(await rows("assignment_runs")).toHaveLength(1);
  });

  it("tells the owner once about a run refused while the flag is off", async () => {
    await linkBot();
    const connector = await addConnector();
    const { actionRequest } = await propose(blogContent(connector.id));
    await confirm(actionRequest.id);
    process.env.ORBIT_BLOG_GITHUB = "false";
    await run((tx) => planAssignmentRuns(tx, project.owner, tomorrowMorning()));
    await run((tx) => planAssignmentRuns(tx, project.owner, tomorrowMorning()));
    const [refused] = await rows("assignment_runs");
    expect(await notices("run_problem")).toHaveLength(1);
    expect((await notices("run_problem"))[0]!.idempotencyKey).toBe(
      `notify:run_problem:${refused!.id}`,
    );
    const problems = await run(async (tx) =>
      runProblems(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", refused!.id),
      ),
    );
    expect(problems.failed).toEqual([
      { stepKey: "run", role: null, code: "BLOG_GITHUB_DISABLED" },
    ]);
  });

  it("ends a refused one-off assignment like a one-off whose run is over", async () => {
    const connector = await addConnector();
    const morning = tomorrowMorning();
    const date = morning.toISOString().slice(0, 10);
    const { assignment, actionRequest } = await propose({
      ...blogContent(connector.id),
      kind: "one_off",
      schedule: { rhythm: "once", weekdays: [], times: ["10:00"], date },
    });
    await confirm(actionRequest.id);
    process.env.ORBIT_BLOG_GITHUB = "false";
    await run((tx) => planAssignmentRuns(tx, project.owner, morning));
    expect(await rows("assignment_runs")).toMatchObject([
      { status: "failed", errorCode: "BLOG_GITHUB_DISABLED" },
    ]);
    const ended = await assignmentOf(assignment.id);
    expect(ended.status).toBe("ended");
    expect(typeof ended.completedAt).toBe("string");
    expect(ended.confirmation.delivery).toBe("github_pr");
  });

  it("checks the blog target again on confirmation and on resume", async () => {
    const connector = await addConnector();
    const first = await propose(blogContent(connector.id));
    await setConnector(connector.id, "read_verified");
    await expect(confirm(first.actionRequest.id)).rejects.toThrow(
      "BLOG_TARGET_NOT_VERIFIED",
    );
    expect((await assignmentOf(first.assignment.id)).status).toBe("draft");
    await setConnector(connector.id, "write_verified");
    await confirm(first.actionRequest.id);
    await run((tx) =>
      setAssignmentStatus(tx, project.owner, first.assignment.id, "paused"),
    );
    await setConnector(connector.id, "read_verified");
    await expect(
      run((tx) =>
        setAssignmentStatus(tx, project.owner, first.assignment.id, "active"),
      ),
    ).rejects.toThrow("BLOG_TARGET_NOT_VERIFIED");
    process.env.ORBIT_BLOG_GITHUB = "false";
    await setConnector(connector.id, "write_verified");
    await expect(
      run((tx) =>
        setAssignmentStatus(tx, project.owner, first.assignment.id, "active"),
      ),
    ).rejects.toThrow("BLOG_GITHUB_DISABLED");
    expect((await assignmentOf(first.assignment.id)).status).toBe("paused");
  });
});
