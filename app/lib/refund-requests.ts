import { formatPrice } from "~/lib/utils";

/**
 * The confirmation the learner gets in their inbox when they raise a Refund
 * Request. See GLOSSARY.md for the terms used here.
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
      `We have your refund request for ${input.courseTitle}. It is for ${formatPrice(input.amount)}, the amount you paid. An Admin reviews every refund request by hand, and we'll email you when it is approved or declined.`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
