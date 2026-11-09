import { describe, it, expect } from "vitest";
import {
  dayOfRefundWindow,
  isWithinRefundWindow,
  refundDueBy,
  isOverdueRefund,
} from "./refund-dates";
import { RefundState } from "~/db/schema";

// Local-time constructors, because the Refund Window is counted in the
// learner's calendar days, not in hours.
function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour);
}

describe("the Refund Window", () => {
  it("counts the day of purchase as day 0 and the last day as day 14", () => {
    const purchasedAt = at(2026, 3, 1, 23);
    expect(dayOfRefundWindow(purchasedAt, at(2026, 3, 1, 23))).toBe(0);
    expect(dayOfRefundWindow(purchasedAt, at(2026, 3, 2, 1))).toBe(1);
    expect(dayOfRefundWindow(purchasedAt, at(2026, 3, 15, 22))).toBe(14);
  });

  it("is open until the end of the fourteenth day after purchase", () => {
    const purchasedAt = at(2026, 3, 1, 23);
    expect(isWithinRefundWindow(purchasedAt, at(2026, 3, 15, 23))).toBe(true);
    expect(isWithinRefundWindow(purchasedAt, at(2026, 3, 16, 0))).toBe(false);
  });
});

describe("the five-working-day promise", () => {
  it("skips the weekend", () => {
    // Thursday 5 March 2026 → Fri, Mon, Tue, Wed, Thu
    expect(refundDueBy(at(2026, 3, 5))).toBe("2026-03-12");
  });

  it("starts counting on Monday for a Saturday approval", () => {
    // Saturday 7 March 2026 → Mon 9 … Fri 13
    expect(refundDueBy(at(2026, 3, 7))).toBe("2026-03-13");
  });
});

describe("an Overdue Refund", () => {
  const approvedAt = at(2026, 3, 5); // due by Thursday 12 March

  it("is a Pending Refund on the day after it was due", () => {
    expect(
      isOverdueRefund(RefundState.Pending, approvedAt, at(2026, 3, 12, 23))
    ).toBe(false);
    expect(
      isOverdueRefund(RefundState.Pending, approvedAt, at(2026, 3, 13, 0))
    ).toBe(true);
  });

  it("is never an Issued or Failed Refund", () => {
    const late = at(2026, 4, 1);
    expect(isOverdueRefund(RefundState.Issued, approvedAt, late)).toBe(false);
    expect(isOverdueRefund(RefundState.Failed, approvedAt, late)).toBe(false);
  });
});
