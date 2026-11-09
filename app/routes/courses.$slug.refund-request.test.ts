import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { approveRefundRequest, declineRefundRequest } from "~/lib/refunds.server";
import {
  buyCourse,
  completeLessons,
  expectRejection,
  refundRequestForm,
  seedRefundScenario,
} from "~/test/refund-fixtures";

let testDb: ReturnType<typeof createTestDb>;
let currentUserId: number | null = null;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => currentUserId),
}));

vi.mock("~/lib/email.server", () => ({ sendEmail: vi.fn() }));

import { action } from "./courses.$slug.refund-request";

async function raiseRefundRequest(reason?: string) {
  const request = new Request("http://localhost/courses/test-course/refund-request", {
    method: "POST",
    body: refundRequestForm(reason),
  });
  return action({
    params: { slug: "test-course" },
    request,
    context: {},
  } as Parameters<typeof action>[0]);
}

describe("raising a Refund Request", () => {
  let scenario: ReturnType<typeof seedRefundScenario>;

  beforeEach(() => {
    testDb = createTestDb();
    scenario = seedRefundScenario(testDb);
    currentUserId = scenario.learner.id;
  });

  it("is accepted while the learner has completed under half the lessons", async () => {
    completeLessons(testDb, scenario.learner.id, scenario.lessonIds.slice(0, 1));

    const response = await raiseRefundRequest();

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe("/settings");
  });

  it("is rejected once the learner has completed half the lessons", async () => {
    completeLessons(testDb, scenario.learner.id, scenario.lessonIds.slice(0, 2));

    await expectRejection(() => raiseRefundRequest(), 403);
  });

  it("is rejected on a later purchase once a Refund Request for the course was approved", async () => {
    await raiseRefundRequest();
    const [first] = testDb.select().from(schema.refundRequests).all();
    approveRefundRequest(first.id, scenario.admin.id);
    buyCourse(testDb, scenario.learner.id, scenario.course.id);

    await expectRejection(() => raiseRefundRequest(), 403);
  });

  it("can be raised again after a decline, within the original Refund Window", async () => {
    await raiseRefundRequest();
    const [first] = testDb.select().from(schema.refundRequests).all();
    declineRefundRequest(first.id, scenario.admin.id, "You watched most of it.");

    const response = await raiseRefundRequest();

    expect((response as Response).headers.get("Location")).toBe("/settings");
  });
});

describe("raising a Refund Request after a decline, late in the window", () => {
  it("is rejected once the original Refund Window has closed", async () => {
    testDb = createTestDb();
    const scenario = seedRefundScenario(testDb, 15);
    currentUserId = scenario.learner.id;
    testDb
      .insert(schema.refundRequests)
      .values({
        purchaseId: scenario.purchase.id,
        status: schema.RefundRequestStatus.Declined,
        reason: "Not for me.",
        declineReason: "Too late.",
      })
      .run();

    await expectRejection(() => raiseRefundRequest(), 403);
  });
});
