import { RefundState } from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_PROMISE_WORKING_DAYS = 5;

// Refund dates are compared in whole calendar days, not hours — someone who
// buys at 23:00 still gets the whole of their fourteenth day.
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function startOfDay(when: Date): Date {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate());
}

/** The last calendar day on which a Refund Request may be raised. */
export function lastDayOfRefundWindow(purchasedAt: Date): string {
  const lastDay = startOfDay(purchasedAt);
  lastDay.setDate(lastDay.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(lastDay);
}

export function isWithinRefundWindow(purchasedAt: Date, now: Date): boolean {
  const today = calendarDay(now);
  return (
    today >= calendarDay(purchasedAt) &&
    today <= lastDayOfRefundWindow(purchasedAt)
  );
}

/** Day 0 is the day of purchase; day 14 is the last day of the window. */
export function dayOfRefundWindow(purchasedAt: Date, when: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  // Rounding absorbs the odd 23- or 25-hour day around a clock change.
  return Math.round(
    (startOfDay(when).getTime() - startOfDay(purchasedAt).getTime()) / msPerDay
  );
}

/**
 * The calendar day by which the learner was promised their money: five
 * working days (Monday to Friday) after approval.
 */
export function refundDueBy(approvedAt: Date): string {
  const due = startOfDay(approvedAt);
  let workingDays = 0;
  while (workingDays < REFUND_PROMISE_WORKING_DAYS) {
    due.setDate(due.getDate() + 1);
    const weekday = due.getDay();
    if (weekday !== 0 && weekday !== 6) workingDays++;
  }
  return calendarDay(due);
}

/** A Pending Refund still not Issued after the day it was due by. */
export function isOverdueRefund(
  state: RefundState,
  approvedAt: Date,
  now: Date
): boolean {
  return (
    state === RefundState.Pending && calendarDay(now) > refundDueBy(approvedAt)
  );
}
