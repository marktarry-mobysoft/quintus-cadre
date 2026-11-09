import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "~/test/setup";
import {
  buyCourse,
  completeLessons,
  expectRejection,
  seedRefundScenario,
} from "~/test/refund-fixtures";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

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

vi.mock("~/lib/country.server", () => ({
  resolveCountry: vi.fn(async () => null),
}));

const sendEmail = vi.fn();
vi.mock("~/lib/email.server", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import {
  approveRefundRequest,
  countRefundsNeedingAttention,
  declineRefundRequest,
  getCourseUsage,
  getRefundOverview,
  markRefundFailed,
  markRefundIssued,
  listLearnerRefundRequests,
} from "./refunds.server";
import { getAccess } from "./access.server";

function raiseOpenRefundRequest(purchaseId: number) {
  return testDb
    .insert(schema.refundRequests)
    .values({
      purchaseId,
      status: schema.RefundRequestStatus.Open,
      reason: "Not what I expected.",
    })
    .returning()
    .get();
}

function addTeamSeats(purchaseId: number, courseId: number, claimedBy: number[]) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const codes = ["SEAT-A", "SEAT-B", "SEAT-C"];
  codes.forEach((code, i) => {
    const claimer = claimedBy[i];
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        purchaseId,
        code,
        redeemedByUserId: claimer ?? null,
        redeemedAt: claimer ? new Date().toISOString() : null,
      })
      .run();
  });
}

function seatCodes() {
  return testDb.select().from(schema.coupons).all();
}

async function learnerAccess(userId: number, courseId: number) {
  currentUserId = userId;
  return getAccess(new Request("http://localhost/"), courseId);
}

describe("approving a Refund Request", () => {
  let scenario: ReturnType<typeof seedRefundScenario>;
  let refundRequestId: number;

  beforeEach(() => {
    testDb = createTestDb();
    sendEmail.mockReset();
    scenario = seedRefundScenario(testDb);
    refundRequestId = raiseOpenRefundRequest(scenario.purchase.id).id;
  });

  it("ends the learner's access to the course", async () => {
    approveRefundRequest(refundRequestId, scenario.admin.id);

    const access = await learnerAccess(scenario.learner.id, scenario.course.id);
    expect(access.canViewContent).toBe(false);
  });

  it("shows the learner their Refund is on its way", () => {
    approveRefundRequest(refundRequestId, scenario.admin.id);

    expect(listLearnerRefundRequests(scenario.learner.id)).toMatchObject([
      { id: refundRequestId, courseTitle: "Test Course", status: "on-its-way" },
    ]);
  });

  it("removes the learner's course rating but keeps their comments", () => {
    const { learner, course, lessonIds } = scenario;
    testDb
      .insert(schema.courseRatings)
      .values({ userId: learner.id, courseId: course.id, rating: 2 })
      .run();
    testDb
      .insert(schema.comments)
      .values({ userId: learner.id, lessonId: lessonIds[0], body: "Hmm." })
      .run();

    approveRefundRequest(refundRequestId, scenario.admin.id);

    expect(testDb.select().from(schema.courseRatings).all()).toEqual([]);
    expect(testDb.select().from(schema.comments).all()).toMatchObject([
      { userId: learner.id, body: "Hmm.", deletedAt: null },
    ]);
  });

  it("restores the learner's progress if they buy the course again", async () => {
    const { learner, course, lessonIds } = scenario;
    completeLessons(testDb, learner.id, lessonIds.slice(0, 1));

    approveRefundRequest(refundRequestId, scenario.admin.id);
    buyCourse(testDb, learner.id, course.id);

    expect((await learnerAccess(learner.id, course.id)).canViewContent).toBe(true);
    expect(getCourseUsage(learner.id, course.id).completedLessons).toBe(1);
  });

  it("emails the learner that the full amount is coming within 5 working days", () => {
    approveRefundRequest(refundRequestId, scenario.admin.id);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sendEmail.mock.calls[0][0];
    expect(email.to).toBe("test@example.com");
    expect(email.body).toContain("$79");
    expect(email.body).toContain("within 5 working days");
  });

  it("revokes a team licence's unclaimed seat codes", () => {
    addTeamSeats(scenario.purchase.id, scenario.course.id, []);

    approveRefundRequest(refundRequestId, scenario.admin.id);

    expect(seatCodes().every((seat) => seat.revokedAt !== null)).toBe(true);
  });

  it("leaves the buyer's own access alone when their team licence is refunded", async () => {
    const teamPurchase = testDb
      .insert(schema.purchases)
      .values({ userId: scenario.learner.id, courseId: scenario.course.id, amountPaid: 23700 })
      .returning()
      .get();
    addTeamSeats(teamPurchase.id, scenario.course.id, []);
    const teamRequest = raiseOpenRefundRequest(teamPurchase.id);

    approveRefundRequest(teamRequest.id, scenario.admin.id);

    const access = await learnerAccess(scenario.learner.id, scenario.course.id);
    expect(access.canViewContent).toBe(true);
  });

  it("is refused once any seat on the team licence has been claimed", async () => {
    addTeamSeats(scenario.purchase.id, scenario.course.id, [scenario.instructor.id]);

    await expectRejection(
      () => approveRefundRequest(refundRequestId, scenario.admin.id),
      409
    );
    expect(listLearnerRefundRequests(scenario.learner.id)[0].status).toBe("open");
  });

  it("can only be done by an Admin", async () => {
    await expectRejection(
      () => approveRefundRequest(refundRequestId, scenario.instructor.id),
      403
    );
  });

  it("can't be done by the Admin who raised the request", async () => {
    const purchase = buyCourse(testDb, scenario.admin.id, scenario.course.id);
    const ownRequest = raiseOpenRefundRequest(purchase.id);

    await expectRejection(
      () => approveRefundRequest(ownRequest.id, scenario.admin.id),
      403
    );
  });

  it("is final", async () => {
    approveRefundRequest(refundRequestId, scenario.admin.id);

    await expectRejection(
      () => approveRefundRequest(refundRequestId, scenario.admin.id),
      409
    );
  });
});

describe("declining a Refund Request", () => {
  let scenario: ReturnType<typeof seedRefundScenario>;
  let refundRequestId: number;

  beforeEach(() => {
    testDb = createTestDb();
    sendEmail.mockReset();
    scenario = seedRefundScenario(testDb);
    refundRequestId = raiseOpenRefundRequest(scenario.purchase.id).id;
  });

  it("tells the learner the Admin's reason, by email and on their settings page", () => {
    declineRefundRequest(refundRequestId, scenario.admin.id, "You finished the course.");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].body).toContain("You finished the course.");
    expect(listLearnerRefundRequests(scenario.learner.id)).toMatchObject([
      { status: "declined", declineReason: "You finished the course." },
    ]);
  });

  it("needs a reason", async () => {
    await expectRejection(
      () => declineRefundRequest(refundRequestId, scenario.admin.id, "   "),
      400
    );
  });

  it("leaves the learner's access alone", async () => {
    declineRefundRequest(refundRequestId, scenario.admin.id, "No.");

    const access = await learnerAccess(scenario.learner.id, scenario.course.id);
    expect(access.canViewContent).toBe(true);
  });

  it("is allowed even when a team seat has been claimed", () => {
    addTeamSeats(scenario.purchase.id, scenario.course.id, [scenario.instructor.id]);

    declineRefundRequest(refundRequestId, scenario.admin.id, "Seats in use.");

    expect(listLearnerRefundRequests(scenario.learner.id)[0].status).toBe("declined");
  });

  it("can only be done by an Admin, and only once", async () => {
    await expectRejection(
      () => declineRefundRequest(refundRequestId, scenario.learner.id, "No."),
      403
    );
    declineRefundRequest(refundRequestId, scenario.admin.id, "No.");
    await expectRejection(
      () => declineRefundRequest(refundRequestId, scenario.admin.id, "No."),
      409
    );
  });
});

describe("sending the money for an approved Refund", () => {
  let scenario: ReturnType<typeof seedRefundScenario>;
  let refundRequestId: number;

  beforeEach(() => {
    testDb = createTestDb();
    scenario = seedRefundScenario(testDb);
    refundRequestId = raiseOpenRefundRequest(scenario.purchase.id).id;
    approveRefundRequest(refundRequestId, scenario.admin.id);
    sendEmail.mockReset();
  });

  it("shows the learner 'Refunded' and emails them once it is Issued", () => {
    markRefundIssued(refundRequestId, scenario.admin.id);

    expect(listLearnerRefundRequests(scenario.learner.id)[0].status).toBe("refunded");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].body).toContain("$79");
  });

  it("keeps a Failed Refund hidden from the learner, and lets it be retried and Issued", () => {
    markRefundFailed(refundRequestId, scenario.admin.id);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(listLearnerRefundRequests(scenario.learner.id)[0].status).toBe("on-its-way");

    markRefundIssued(refundRequestId, scenario.admin.id);
    expect(listLearnerRefundRequests(scenario.learner.id)[0].status).toBe("refunded");
  });

  it("can't be recorded for a Refund Request that wasn't approved", async () => {
    const other = buyCourse(testDb, scenario.instructor.id, scenario.course.id);
    const openRequest = raiseOpenRefundRequest(other.id);

    await expectRejection(() => markRefundIssued(openRequest.id, scenario.admin.id), 409);
    await expectRejection(() => markRefundFailed(openRequest.id, scenario.admin.id), 409);
  });

  it("can't be recorded twice once Issued", async () => {
    markRefundIssued(refundRequestId, scenario.admin.id);

    await expectRejection(() => markRefundIssued(refundRequestId, scenario.admin.id), 409);
    await expectRejection(() => markRefundFailed(refundRequestId, scenario.admin.id), 409);
  });

  it("can only be recorded by an Admin", async () => {
    await expectRejection(
      () => markRefundIssued(refundRequestId, scenario.instructor.id),
      403
    );
  });
});

describe("the Admin's overview of Refund Requests", () => {
  const now = new Date(2026, 2, 20, 12); // Friday 20 March 2026

  function daysBefore(days: number) {
    const when = new Date(now);
    when.setDate(when.getDate() - days);
    return when.toISOString();
  }

  beforeEach(() => {
    testDb = createTestDb();
  });

  it("lists Open Refund Requests oldest first, with how far into the Refund Window each was raised", () => {
    const scenario = seedRefundScenario(testDb);
    testDb.update(schema.purchases).set({ createdAt: daysBefore(10) }).run();
    const other = buyCourse(testDb, scenario.instructor.id, scenario.course.id);
    testDb
      .update(schema.purchases)
      .set({ createdAt: daysBefore(5) })
      .where(eq(schema.purchases.id, other.id))
      .run();
    testDb
      .insert(schema.refundRequests)
      .values([
        { purchaseId: other.id, reason: "Newer.", requestedAt: daysBefore(1) },
        {
          purchaseId: scenario.purchase.id,
          reason: "Older.",
          requestedAt: daysBefore(3),
          completedLessonsAtRequest: 1,
          totalLessonsAtRequest: 4,
          watchedSecondsAtRequest: 1800,
        },
      ])
      .run();
    completeLessons(testDb, scenario.learner.id, scenario.lessonIds.slice(0, 3));

    const { openRefundRequests } = getRefundOverview(now);

    expect(openRefundRequests).toMatchObject([
      {
        reason: "Older.",
        learnerName: "Test User",
        courseTitle: "Test Course",
        amountPaid: 7900,
        dayOfRefundWindow: 7,
        atRequest: { completedLessons: 1, totalLessons: 4, watchedSeconds: 1800 },
        now: { completedLessons: 3, totalLessons: 4 },
      },
      { reason: "Newer.", dayOfRefundWindow: 4 },
    ]);
  });

  it("shows earlier Declined Refund Requests on the same purchase", () => {
    const scenario = seedRefundScenario(testDb);
    testDb
      .insert(schema.refundRequests)
      .values([
        {
          purchaseId: scenario.purchase.id,
          status: schema.RefundRequestStatus.Declined,
          reason: "First try.",
          declineReason: "Not convinced.",
          requestedAt: daysBefore(2),
        },
        { purchaseId: scenario.purchase.id, reason: "Second try.", requestedAt: daysBefore(1) },
      ])
      .run();

    const { openRefundRequests } = getRefundOverview(now);

    expect(openRefundRequests).toHaveLength(1);
    expect(openRefundRequests[0].earlierDeclines).toMatchObject([
      { reason: "First try.", declineReason: "Not convinced." },
    ]);
  });

  it("flags a Pending Refund as Overdue five working days after approval, and counts it for the badge", () => {
    const scenario = seedRefundScenario(testDb);
    const request = raiseOpenRefundRequest(scenario.purchase.id);
    // Approved Friday 13 March → due Friday 20 March → Overdue from Saturday.
    approveRefundRequest(request.id, scenario.admin.id, new Date(2026, 2, 13, 9));

    expect(getRefundOverview(now).unissuedRefunds).toMatchObject([
      { id: request.id, refundState: schema.RefundState.Pending, overdue: false },
    ]);
    expect(countRefundsNeedingAttention(now)).toBe(0);

    const saturday = new Date(2026, 2, 21, 9);
    expect(getRefundOverview(saturday).unissuedRefunds[0].overdue).toBe(true);
    expect(countRefundsNeedingAttention(saturday)).toBe(1);
  });

  it("counts Open Refund Requests for the badge, and drops Issued Refunds from the list", () => {
    const scenario = seedRefundScenario(testDb);
    const issued = raiseOpenRefundRequest(scenario.purchase.id);
    approveRefundRequest(issued.id, scenario.admin.id, now);
    markRefundIssued(issued.id, scenario.admin.id);
    const other = buyCourse(testDb, scenario.instructor.id, scenario.course.id);
    raiseOpenRefundRequest(other.id);

    expect(getRefundOverview(now).unissuedRefunds).toEqual([]);
    expect(countRefundsNeedingAttention(now)).toBe(1);
  });
});
