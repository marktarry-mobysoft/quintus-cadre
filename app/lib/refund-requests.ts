import { formatPrice } from "~/lib/utils";

// The rules for when a Learner may make a Refund Request. See GLOSSARY.md for
// the terms used here.

/** Days after purchase during which a Learner may request a refund. */
export const REFUND_WINDOW_DAYS = 14;

/** Watching this much of a course rules out a Refund Request. */
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;

/** Completing this share of a course's lessons rules out a Refund Request. */
export const REFUND_COMPLETION_LIMIT = 0.5;

/**
 * The confirmation the Learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
export function buildRefundRequestedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund requested: ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for ${input.courseTitle}. It is for ${formatPrice(input.amount)}, the amount you paid. Our team will look at it and we'll email you when it is approved or declined.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
