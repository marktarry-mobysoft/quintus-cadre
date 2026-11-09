import { data, redirect } from "react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/courses.$slug.refund-request";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, refundRequests, users, RefundRequestStatus } from "~/db/schema";
import { parseFormData, parseParams } from "~/lib/validation";
import { checkRefundEligibility } from "~/lib/refunds.server";
import { sendEmail } from "~/lib/email.server";
import { buildRefundRequestedEmail } from "~/lib/refund-requests";

const refundRequestParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundRequestActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundRequestParamsSchema);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const eligibility = checkRefundEligibility(currentUserId, course.id);

  if (!eligibility.eligible) {
    throw data(eligibility.message, { status: eligibility.status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const { purchase, usage } = eligibility;

  db.insert(refundRequests)
    .values({
      purchaseId: purchase.id,
      status: RefundRequestStatus.Open,
      reason: parsed.data.reason,
      completedLessonsAtRequest: usage.completedLessons,
      totalLessonsAtRequest: usage.totalLessons,
      watchedSecondsAtRequest: usage.watchedSeconds,
    })
    .run();

  sendEmail(
    buildRefundRequestedEmail({
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      amount: purchase.amountPaid,
    })
  );

  return redirect("/settings");
}
