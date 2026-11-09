import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import { requireUserId } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { REFUND_WINDOW_DAYS } from "~/lib/refund-dates";
import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundOverview,
  markRefundFailed,
  markRefundIssued,
  type CourseUsage,
} from "~/lib/refunds.server";
import { RefundState, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

const refundRequestActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z
      .string()
      .trim()
      .min(1, "Give the learner a reason for declining.")
      .max(1000, "Keep the reason under 1000 characters."),
  }),
  z.object({
    intent: z.literal("mark-issued"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-failed"),
    refundRequestId: z.coerce.number().int(),
  }),
]);

async function requireAdminId(request: Request) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== UserRole.Admin) {
    throw data("Only an Admin can manage Refund Requests.", { status: 403 });
  }
  return userId;
}

export function meta() {
  return [
    { title: "Manage Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const adminId = await requireAdminId(request);
  return { adminId, ...getRefundOverview() };
}

export async function action({ request }: Route.ActionArgs) {
  const adminId = await requireAdminId(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const { intent, refundRequestId } = parsed.data;

  switch (intent) {
    case "approve":
      approveRefundRequest(refundRequestId, adminId);
      return { message: "Refund Request approved." };
    case "decline":
      declineRefundRequest(refundRequestId, adminId, parsed.data.declineReason);
      return { message: "Refund Request declined." };
    case "mark-issued":
      markRefundIssued(refundRequestId, adminId);
      return { message: "Refund marked Issued." };
    case "mark-failed":
      markRefundFailed(refundRequestId, adminId);
      return { message: "Refund marked Failed." };
  }
}

function formatHours(seconds: number) {
  return `${(seconds / 3600).toFixed(1)}h watched`;
}

function formatShare(usage: CourseUsage) {
  if (usage.totalLessons === 0) return "no lessons";
  const percent = Math.round((usage.completedLessons / usage.totalLessons) * 100);
  return `${usage.completedLessons}/${usage.totalLessons} lessons (${percent}%)`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type Overview = Route.ComponentProps["loaderData"];
type OpenRefundRequest = Overview["openRefundRequests"][number];
type UnissuedRefund = Overview["unissuedRefunds"][number];

function useActionToast(fetcher: ReturnType<typeof useFetcher<typeof action>>) {
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("message" in fetcher.data) toast.success(fetcher.data.message);
    if ("errors" in fetcher.data) {
      const first = Object.values(fetcher.data.errors)[0];
      if (first) toast.error(first);
    }
  }, [fetcher.state, fetcher.data]);
}

function OpenRefundRequestCard({
  refundRequest,
  adminId,
}: {
  refundRequest: OpenRefundRequest;
  adminId: number;
}) {
  const fetcher = useFetcher<typeof action>();
  const [declining, setDeclining] = useState(false);
  useActionToast(fetcher);

  const busy = fetcher.state !== "idle";
  const ownRequest = refundRequest.learnerId === adminId;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">
              {refundRequest.learnerName}{" "}
              <span className="font-normal text-muted-foreground">
                ({refundRequest.learnerEmail})
              </span>
            </h3>
            <p className="text-sm text-muted-foreground">
              <Link to={`/courses/${refundRequest.courseSlug}`} className="hover:underline">
                {refundRequest.courseTitle}
              </Link>{" "}
              · paid {formatPrice(refundRequest.amountPaid)} · raised{" "}
              {formatDate(refundRequest.requestedAt)}, day{" "}
              {refundRequest.dayOfRefundWindow} of {REFUND_WINDOW_DAYS}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <blockquote className="border-l-2 pl-3 text-sm">{refundRequest.reason}</blockquote>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">At request</dt>
          <dd>
            {formatShare(refundRequest.atRequest)} ·{" "}
            {formatHours(refundRequest.atRequest.watchedSeconds)}
          </dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>
            {formatShare(refundRequest.now)} · {formatHours(refundRequest.now.watchedSeconds)}
          </dd>
        </dl>

        {refundRequest.earlierDeclines.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Earlier Declined Refund Requests on this purchase</p>
            <ul className="mt-1 space-y-1">
              {refundRequest.earlierDeclines.map((decline) => (
                <li key={decline.id} className="text-muted-foreground">
                  {formatDate(decline.requestedAt)}: “{decline.reason}” — declined
                  because “{decline.declineReason}”
                </li>
              ))}
            </ul>
          </div>
        )}

        {ownRequest ? (
          <p className="text-sm text-muted-foreground">
            You raised this Refund Request, so another Admin must decide it.
          </p>
        ) : declining ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="refundRequestId" value={refundRequest.id} />
            <Label htmlFor={`decline-reason-${refundRequest.id}`}>
              Reason (the learner is emailed this)
            </Label>
            <Textarea
              id={`decline-reason-${refundRequest.id}`}
              name="declineReason"
              rows={3}
              required
              maxLength={1000}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" disabled={busy}>
                {busy ? "Declining..." : "Decline"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDeclining(false)}>
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="approve" />
              <input type="hidden" name="refundRequestId" value={refundRequest.id} />
              <Button type="submit" disabled={busy || refundRequest.hasClaimedSeat}>
                {busy ? "Approving..." : `Approve full refund of ${formatPrice(refundRequest.amountPaid)}`}
              </Button>
            </fetcher.Form>
            <Button type="button" variant="outline" onClick={() => setDeclining(true)}>
              Decline…
            </Button>
            {refundRequest.hasClaimedSeat && (
              <p className="text-sm text-muted-foreground">
                A seat on this team licence has been claimed, so it can only be declined.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UnissuedRefundRow({ refund }: { refund: UnissuedRefund }) {
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher);
  const busy = fetcher.state !== "idle";

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{refund.learnerName}</div>
        <div className="text-xs text-muted-foreground">{refund.learnerEmail}</div>
      </td>
      <td className="px-4 py-3">{refund.courseTitle}</td>
      <td className="px-4 py-3">{formatPrice(refund.amountRefunded)}</td>
      <td className="px-4 py-3">
        {formatDate(refund.approvedAt)}
        <div className="text-xs text-muted-foreground">due by {refund.dueBy}</div>
      </td>
      <td className="px-4 py-3">
        {refund.overdue ? (
          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300">
            Overdue
          </span>
        ) : refund.refundState === RefundState.Failed ? (
          <span className="rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
            Failed
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            Pending
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <fetcher.Form method="post" className="flex gap-2">
          <input type="hidden" name="refundRequestId" value={refund.id} />
          <Button type="submit" name="intent" value="mark-issued" size="sm" disabled={busy}>
            Mark Issued
          </Button>
          {refund.refundState !== RefundState.Failed && (
            <Button
              type="submit"
              name="intent"
              value="mark-failed"
              size="sm"
              variant="outline"
              disabled={busy}
            >
              Mark Failed
            </Button>
          )}
        </fetcher.Form>
      </td>
    </tr>
  );
}

export default function AdminRefundRequests({ loaderData }: Route.ComponentProps) {
  const { adminId, openRefundRequests, unissuedRefunds } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Manage Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Manage Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Decisions are final. Approving refunds the full amount paid and ends the
          learner's access to the course.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-semibold">
          Open Refund Requests ({openRefundRequests.length})
        </h2>
        {openRefundRequests.length === 0 ? (
          <p className="text-muted-foreground">No Refund Requests are waiting on a decision.</p>
        ) : (
          <div className="space-y-4">
            {openRefundRequests.map((refundRequest) => (
              <OpenRefundRequestCard
                key={refundRequest.id}
                refundRequest={refundRequest}
                adminId={adminId}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-xl font-semibold">
          Refunds to send ({unissuedRefunds.length})
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Send the money outside Cadence, then record here whether it went through.
        </p>
        {unissuedRefunds.length === 0 ? (
          <p className="text-muted-foreground">Every approved Refund has been Issued.</p>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Learner</th>
                    <th className="px-4 py-3 font-medium">Course</th>
                    <th className="px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Approved</th>
                    <th className="px-4 py-3 font-medium">State</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {unissuedRefunds.map((refund) => (
                    <UnissuedRefundRow key={refund.id} refund={refund} />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string" ? error.data : "Only an Admin can manage Refund Requests.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/admin/refund-requests">
            <Button>Back to Refund Requests</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
