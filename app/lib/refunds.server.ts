import { data } from "react-router";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courseRatings,
  courses,
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  RefundRequestStatus,
  RefundState,
  refundRequests,
  UserRole,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { sendEmail } from "~/lib/email.server";
import { formatPrice } from "~/lib/utils";
import {
  dayOfRefundWindow,
  isOverdueRefund,
  isWithinRefundWindow,
  REFUND_PROMISE_WORKING_DAYS,
  refundDueBy,
  lastDayOfRefundWindow,
  REFUND_WINDOW_DAYS,
} from "~/lib/refund-dates";

export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
/** A learner who has completed this share of the lessons can't ask for a refund. */
export const REFUND_COMPLETION_LIMIT = 0.5;

// ─── Course usage ───

export type CourseUsage = {
  completedLessons: number;
  totalLessons: number;
  watchedSeconds: number;
};

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/** How far a learner has got through a course: lessons completed and video watched. */
export function getCourseUsage(userId: number, courseId: number): CourseUsage {
  const lessonIds = getCourseLessonIds(courseId);
  if (lessonIds.length === 0) {
    return { completedLessons: 0, totalLessons: 0, watchedSeconds: 0 };
  }

  const completed = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  // Watch time is the furthest point reached in each lesson, so rewatching
  // a lesson doesn't count twice.
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return {
    completedLessons: completed?.count ?? 0,
    totalLessons: lessonIds.length,
    watchedSeconds: furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    ),
  };
}

// ─── Eligibility ───

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt))
    .get();
}

function hasApprovedRefundRequestForCourse(userId: number, courseId: number) {
  return !!db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        eq(refundRequests.status, RefundRequestStatus.Approved)
      )
    )
    .get();
}

function hasOpenRefundRequest(purchaseId: number) {
  return !!db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .get();
}

export function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

type Purchase = typeof purchases.$inferSelect;

export type RefundEligibility =
  | {
      eligible: true;
      purchase: Purchase;
      usage: CourseUsage;
      lastDayInWindow: string;
    }
  | { eligible: false; status: 403 | 409; message: string };

function ineligible(status: 403 | 409, message: string): RefundEligibility {
  return { eligible: false, status, message };
}

/**
 * The one rule for whether a learner may raise a Refund Request for their
 * latest purchase of a course. The course page uses it to decide whether to
 * offer a refund; the refund action uses it to enforce one.
 */
export function checkRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return ineligible(403, "You have not bought this course.");

  // ADR 0001: at most one Approved Refund Request per learner per course, ever.
  if (hasApprovedRefundRequestForCourse(userId, courseId)) {
    return ineligible(
      403,
      "You have already been refunded for this course once, so it can't be refunded again."
    );
  }

  if (hasOpenRefundRequest(purchase.id)) {
    return ineligible(
      409,
      "You already have an open refund request on this purchase."
    );
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (hasClaimedSeat(purchase.id)) {
    return ineligible(403, "A claimed team seat cannot be refunded.");
  }

  const purchasedAt = new Date(purchase.createdAt);
  if (!isWithinRefundWindow(purchasedAt, now)) {
    return ineligible(403, `The ${REFUND_WINDOW_DAYS}-day window has closed.`);
  }

  const usage = getCourseUsage(userId, courseId);

  if (
    usage.totalLessons > 0 &&
    usage.completedLessons / usage.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    return ineligible(
      403,
      "You have completed too much of this course to request a refund."
    );
  }

  if (usage.watchedSeconds >= REFUND_WATCH_LIMIT_SECONDS) {
    return ineligible(
      403,
      "You have watched too much of this course to request a refund."
    );
  }

  return {
    eligible: true,
    purchase,
    usage,
    lastDayInWindow: lastDayOfRefundWindow(purchasedAt),
  };
}

// ─── Admin decisions ───

function getRefundRequest(refundRequestId: number) {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      refundState: refundRequests.refundState,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

type RefundRequestRecord = NonNullable<ReturnType<typeof getRefundRequest>>;

function requireAdmin(userId: number) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== UserRole.Admin) {
    throw data("Only an Admin can do that.", { status: 403 });
  }
  return user;
}

/** Loads an Open Refund Request that this Admin is allowed to decide. */
function requireDecidableRefundRequest(
  refundRequestId: number,
  adminId: number
): RefundRequestRecord {
  requireAdmin(adminId);

  const refundRequest = getRefundRequest(refundRequestId);
  if (!refundRequest) {
    throw data("Refund Request not found.", { status: 404 });
  }

  if (refundRequest.learnerId === adminId) {
    throw data("You can't decide a Refund Request you raised yourself.", {
      status: 403,
    });
  }

  if (refundRequest.status !== RefundRequestStatus.Open) {
    throw data("This Refund Request has already been decided.", {
      status: 409,
    });
  }

  return refundRequest;
}

function signOff(lines: string[], learnerName: string) {
  return [`Hi ${learnerName},`, "", ...lines, "", "— The Cadence team"].join(
    "\n"
  );
}

/**
 * Approves an Open Refund Request. The learner loses access to the course and
 * their rating, and a Pending Refund of the full amount paid is created.
 * Their progress, quiz attempts and watch history are kept (ADR 0002).
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminId: number,
  now: Date = new Date()
) {
  const refundRequest = requireDecidableRefundRequest(refundRequestId, adminId);

  if (hasClaimedSeat(refundRequest.purchaseId)) {
    throw data(
      "A seat on this team licence has been claimed, so it can only be declined.",
      { status: 409 }
    );
  }

  const decidedAt = now.toISOString();
  const { learnerId, courseId } = refundRequest;
  // A team licence hands out seats; it never enrolled its buyer, so refunding
  // it must not take away access they got some other way.
  const isTeamLicence = !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, refundRequest.purchaseId))
    .get();

  db.transaction((tx) => {
    tx.update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        amountRefunded: refundRequest.amountPaid,
        refundState: RefundState.Pending,
        resolvedAt: decidedAt,
        resolvedByUserId: adminId,
      })
      .where(eq(refundRequests.id, refundRequest.id))
      .run();

    if (!isTeamLicence) {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, learnerId),
            eq(enrollments.courseId, courseId)
          )
        )
        .run();

      tx.delete(courseRatings)
        .where(
          and(
            eq(courseRatings.userId, learnerId),
            eq(courseRatings.courseId, courseId)
          )
        )
        .run();
    }

    tx.update(coupons)
      .set({ revokedAt: decidedAt })
      .where(
        and(
          eq(coupons.purchaseId, refundRequest.purchaseId),
          isNull(coupons.redeemedAt),
          isNull(coupons.revokedAt)
        )
      )
      .run();
  });

  sendEmail({
    to: refundRequest.learnerEmail,
    subject: `Refund Request approved — ${refundRequest.courseTitle}`,
    body: signOff(
      [
        `Your refund request for "${refundRequest.courseTitle}" has been approved.`,
        `We will refund ${formatPrice(refundRequest.amountPaid)}, the full amount you paid, within ${REFUND_PROMISE_WORKING_DAYS} working days.`,
        "",
        "You no longer have access to the course.",
      ],
      refundRequest.learnerName
    ),
  });
}

/**
 * Declines an Open Refund Request with a reason the learner is told. They may
 * raise a new one, but only within the original Refund Window.
 */
export function declineRefundRequest(
  refundRequestId: number,
  adminId: number,
  reason: string,
  now: Date = new Date()
) {
  const refundRequest = requireDecidableRefundRequest(refundRequestId, adminId);

  const declineReason = reason.trim();
  if (!declineReason) {
    throw data("Give the learner a reason for declining.", { status: 400 });
  }

  db.update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      declineReason,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
    })
    .where(eq(refundRequests.id, refundRequest.id))
    .run();

  sendEmail({
    to: refundRequest.learnerEmail,
    subject: `Refund Request declined — ${refundRequest.courseTitle}`,
    body: signOff(
      [
        `Your refund request for "${refundRequest.courseTitle}" has been declined, for this reason:`,
        "",
        declineReason,
        "",
        `You can still raise a new refund request while your original ${REFUND_WINDOW_DAYS}-day refund window is open.`,
      ],
      refundRequest.learnerName
    ),
  });
}

// ─── Sending the money ───
// There's no payment provider: an Admin sends the money outside the app and
// records here whether it went through.

function requireRefundAwaitingIssue(refundRequestId: number, adminId: number) {
  requireAdmin(adminId);

  const refundRequest = getRefundRequest(refundRequestId);
  if (!refundRequest) {
    throw data("Refund Request not found.", { status: 404 });
  }

  if (
    refundRequest.status !== RefundRequestStatus.Approved ||
    refundRequest.refundState === RefundState.Issued
  ) {
    throw data("Only a Refund that hasn't been Issued can be updated.", {
      status: 409,
    });
  }

  return refundRequest;
}

/** The money reached the learner. Works for a Pending or a Failed Refund. */
export function markRefundIssued(
  refundRequestId: number,
  adminId: number,
  now: Date = new Date()
) {
  const refundRequest = requireRefundAwaitingIssue(refundRequestId, adminId);

  db.update(refundRequests)
    .set({ refundState: RefundState.Issued, issuedAt: now.toISOString() })
    .where(eq(refundRequests.id, refundRequest.id))
    .run();

  sendEmail({
    to: refundRequest.learnerEmail,
    subject: `Refund sent — ${refundRequest.courseTitle}`,
    body: signOff(
      [
        `We have sent your refund of ${formatPrice(refundRequest.amountPaid)} for "${refundRequest.courseTitle}".`,
      ],
      refundRequest.learnerName
    ),
  });
}

/** The money couldn't be sent. The learner isn't told; the Admin retries. */
export function markRefundFailed(refundRequestId: number, adminId: number) {
  const refundRequest = requireRefundAwaitingIssue(refundRequestId, adminId);

  db.update(refundRequests)
    .set({ refundState: RefundState.Failed })
    .where(eq(refundRequests.id, refundRequest.id))
    .run();
}

// ─── The Admin's overview ───

function listOpenRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      completedLessonsAtRequest: refundRequests.completedLessonsAtRequest,
      totalLessonsAtRequest: refundRequests.totalLessonsAtRequest,
      watchedSecondsAtRequest: refundRequests.watchedSecondsAtRequest,
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all();
}

function listDeclinedRefundRequests(purchaseIds: number[]) {
  if (purchaseIds.length === 0) return [];
  return db
    .select({
      id: refundRequests.id,
      purchaseId: refundRequests.purchaseId,
      reason: refundRequests.reason,
      declineReason: refundRequests.declineReason,
      requestedAt: refundRequests.requestedAt,
      resolvedAt: refundRequests.resolvedAt,
    })
    .from(refundRequests)
    .where(
      and(
        inArray(refundRequests.purchaseId, purchaseIds),
        eq(refundRequests.status, RefundRequestStatus.Declined)
      )
    )
    .orderBy(asc(refundRequests.requestedAt))
    .all();
}

function listUnissuedRefunds() {
  return db
    .select({
      id: refundRequests.id,
      refundState: refundRequests.refundState,
      amountRefunded: refundRequests.amountRefunded,
      approvedAt: refundRequests.resolvedAt,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      inArray(refundRequests.refundState, [RefundState.Pending, RefundState.Failed])
    )
    .orderBy(asc(refundRequests.resolvedAt))
    .all()
    .flatMap(({ refundState, approvedAt, amountRefunded, ...rest }) => {
      // An approved request always has these; skip anything that doesn't.
      if (!refundState || !approvedAt || amountRefunded === null) return [];
      return [{ ...rest, refundState, approvedAt, amountRefunded }];
    });
}

/**
 * Everything an Admin needs on the Refund Requests page: the Open Refund
 * Requests to decide, oldest first, and the Refunds whose money hasn't been
 * confirmed as sent.
 */
export function getRefundOverview(now: Date = new Date()) {
  const open = listOpenRefundRequests();
  const declines = listDeclinedRefundRequests(open.map((r) => r.purchaseId));

  const openRefundRequests = open.map((request) => ({
    id: request.id,
    reason: request.reason,
    requestedAt: request.requestedAt,
    amountPaid: request.amountPaid,
    learnerId: request.learnerId,
    learnerName: request.learnerName,
    learnerEmail: request.learnerEmail,
    courseTitle: request.courseTitle,
    courseSlug: request.courseSlug,
    dayOfRefundWindow: dayOfRefundWindow(
      new Date(request.purchasedAt),
      new Date(request.requestedAt)
    ),
    atRequest: {
      completedLessons: request.completedLessonsAtRequest,
      totalLessons: request.totalLessonsAtRequest,
      watchedSeconds: request.watchedSecondsAtRequest,
    },
    now: getCourseUsage(request.learnerId, request.courseId),
    hasClaimedSeat: hasClaimedSeat(request.purchaseId),
    earlierDeclines: declines.filter((d) => d.purchaseId === request.purchaseId),
  }));

  const unissuedRefunds = listUnissuedRefunds().map((refund) => ({
    ...refund,
    dueBy: refundDueBy(new Date(refund.approvedAt)),
    overdue: isOverdueRefund(refund.refundState, new Date(refund.approvedAt), now),
  }));

  return { openRefundRequests, unissuedRefunds };
}

/** For the nav badge: Open Refund Requests plus Overdue Refunds. */
export function countRefundsNeedingAttention(now: Date = new Date()) {
  const open = db
    .select({ count: sql<number>`count(*)` })
    .from(refundRequests)
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .get();

  const overdue = listUnissuedRefunds().filter((refund) =>
    isOverdueRefund(refund.refundState, new Date(refund.approvedAt), now)
  ).length;

  return (open?.count ?? 0) + overdue;
}

// ─── The learner's view ───

/** How a learner sees a Refund Request. Failed and Overdue are internal. */
export type LearnerRefundRequestStatus =
  | "open"
  | "declined"
  | "on-its-way"
  | "refunded";

function learnerStatus(
  status: RefundRequestStatus,
  refundState: RefundState | null
): LearnerRefundRequestStatus {
  if (status === RefundRequestStatus.Open) return "open";
  if (status === RefundRequestStatus.Declined) return "declined";
  return refundState === RefundState.Issued ? "refunded" : "on-its-way";
}

/** Every Refund Request the learner has raised, newest first. */
export function listLearnerRefundRequests(userId: number) {
  return db
    .select({
      id: refundRequests.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      status: refundRequests.status,
      refundState: refundRequests.refundState,
      declineReason: refundRequests.declineReason,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(refundRequests.requestedAt), desc(refundRequests.id))
    .all()
    .map(({ status, refundState, declineReason, ...rest }) => ({
      ...rest,
      status: learnerStatus(status, refundState),
      declineReason:
        status === RefundRequestStatus.Declined ? declineReason : null,
    }));
}
