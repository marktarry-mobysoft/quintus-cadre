import { describe, it, expect } from "vitest";
import { buildRefundRequestedEmail } from "./refund-requests";

describe("buildRefundRequestedEmail", () => {
  const email = buildRefundRequestedEmail({
    learnerName: "Liam",
    learnerEmail: "liam@example.com",
    courseTitle: "Introduction to TypeScript",
    amount: 7900,
  });

  it("is sent to the learner", () => {
    expect(email.to).toBe("liam@example.com");
  });

  it("names the course in the subject", () => {
    expect(email.subject).toBe("Refund requested: Introduction to TypeScript");
  });

  it("confirms the refund request, amount and what happens next", () => {
    expect(email.body).toContain("Hi Liam,");
    expect(email.body).toContain(
      "We have your refund request for Introduction to TypeScript. It is for $79.00, the amount you paid. Our team will look at it and we'll email you when it is approved or declined."
    );
  });

  it("uses only the glossary terms", () => {
    const text = `${email.subject}\n${email.body}`;
    expect(text).not.toMatch(
      /reversal|chargeback|cancel|pending|\bopen\b|raised/i
    );
  });
});
