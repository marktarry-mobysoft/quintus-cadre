import { expect } from "vitest";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "./setup";

type TestDb = ReturnType<typeof createTestDb>;

/**
 * A published course with four lessons, a learner who bought it `daysAgo`
 * days ago for $79, and an Admin.
 */
export function seedRefundScenario(testDb: TestDb, purchasedDaysAgo = 3) {
  const base = seedBaseData(testDb);
  const learner = base.user;

  const admin = testDb
    .insert(schema.users)
    .values({ name: "Ada Admin", email: "admin@example.com", role: schema.UserRole.Admin })
    .returning()
    .get();

  testDb
    .update(schema.courses)
    .set({ price: 7900 })
    .run();

  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  const lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );

  const purchase = buyCourse(testDb, learner.id, base.course.id, purchasedDaysAgo);

  return { ...base, learner, admin, lessonIds, purchase };
}

export function daysAgo(days: number): string {
  const when = new Date();
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

export function buyCourse(
  testDb: TestDb,
  userId: number,
  courseId: number,
  purchasedDaysAgo = 0
) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid: 7900, createdAt: daysAgo(purchasedDaysAgo) })
    .returning()
    .get();
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
  return purchase;
}

export function completeLessons(testDb: TestDb, userId: number, lessonIds: number[]) {
  for (const lessonId of lessonIds) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
        completedAt: new Date().toISOString(),
      })
      .run();
  }
}

export function refundRequestForm(reason = "It was not what I expected at all.") {
  const body = new FormData();
  body.set("reason", reason);
  return body;
}

/** Asserts that `run` throws (or rejects with) a response with this status. */
export async function expectRejection(run: () => unknown, status: number) {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ init: { status } });
}
