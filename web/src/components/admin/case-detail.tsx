import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge, UrgencyBadge } from "@/components/status-badge";
import { ApprovalCard } from "@/components/admin/approval-card";
import type { SupportCase } from "@/lib/types";
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  PackageSearch,
  Receipt,
  ScrollText,
} from "lucide-react";

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function CaseDetail({
  supportCase,
  approverId,
  onDecision,
}: {
  supportCase: SupportCase;
  approverId: string;
  onDecision: (
    approved: boolean,
    commandFingerprint: string,
    note?: string,
  ) => Promise<void>;
}) {
  const c = supportCase;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{c.subject}</h2>
          <p className="text-sm text-muted-foreground">
            {c.customer.name ?? c.customer.email} &lt;{c.customer.email}&gt; ·
            Case {c.id} · via {c.source}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={c.status} />
          {c.triage && (
            <>
              <Badge variant="secondary" className="capitalize">
                {c.triage.intent.replace(/_/g, " ")}
              </Badge>
              <UrgencyBadge urgency={c.triage.urgency} />
            </>
          )}
        </div>
      </div>

      {c.status === "waiting_approval" && (
        <ApprovalCard
          supportCase={c}
          approverId={approverId}
          onDecision={onDecision}
        />
      )}

      {c.status === "escalated" && c.escalationReason && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Escalated</AlertTitle>
          <AlertDescription>
            <p>{c.escalationReason}</p>
            {c.approval && (
              <p>
                Decision by {c.approval.approverId}
                {c.approval.note ? `: "${c.approval.note}"` : ""}
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {c.refundResult && (
        <Alert>
          <BadgeCheck />
          <AlertTitle>
            Refund{" "}
            {c.refundResult.status === "skipped"
              ? "already issued"
              : c.refundResult.status === "pending"
                ? "pending reconciliation"
                : c.refundResult.status === "failed"
                  ? "failed; staff review required"
                  : "issued"}
            : {c.refundResult.amount} {c.refundResult.currency}
          </AlertTitle>
          <AlertDescription>
            {c.refundResult.refundId} · order {c.refundResult.orderId} ·{" "}
            {new Date(c.refundResult.executedAt).toLocaleString()}
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="conversation">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="reasoning">AI reasoning</TabsTrigger>
          <TabsTrigger value="data">Order &amp; policy data</TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="flex flex-col gap-2">
          {c.messages.map((message) => (
            <div key={message.id} className="rounded-lg border p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground capitalize">
                  {message.authorName ?? message.author}
                </span>
                <span>{new Date(message.createdAt).toLocaleString()}</span>
              </div>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="reasoning" className="flex flex-col gap-4">
          {c.triage && (
            <Section
              icon={ScrollText}
              title="Triage"
              description="How the agent classified the case before drafting a response."
            >
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="capitalize">
                    {c.triage.intent.replace(/_/g, " ")}
                  </Badge>
                  <UrgencyBadge urgency={c.triage.urgency} />
                  <Badge variant="outline" className="capitalize">
                    {c.triage.sentiment}
                  </Badge>
                  <Badge variant="outline">
                    {Math.round(c.triage.confidence * 100)}% confidence
                  </Badge>
                  {c.triage.requiresHumanReview && (
                    <Badge variant="destructive">Flagged for review</Badge>
                  )}
                </div>
                <p className="text-muted-foreground">{c.triage.rationale}</p>
              </div>
            </Section>
          )}

          {c.policyMatches && c.policyMatches.length > 0 && (
            <>
              <Separator />
              <Section
                icon={Receipt}
                title="Retrieved policy context"
                description="The passages pulled from the knowledge base to ground the reply."
              >
                <div className="flex flex-col gap-3">
                  {c.policyMatches.map((match, i) => (
                    <div
                      key={`${match.source}-${i}`}
                      className="flex flex-col gap-1 border-b pb-2 last:border-0 last:pb-0"
                    >
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {match.title}
                        </span>
                        <span>score {match.score.toFixed(2)}</span>
                      </div>
                      <p className="line-clamp-3 text-muted-foreground">
                        {match.text}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Source: {match.source}
                        {match.version ? ` · version ${match.version}` : ""}
                        {match.effectiveAt
                          ? ` · effective ${new Date(match.effectiveAt).toLocaleDateString()}`
                          : ""}
                        {match.expiresAt
                          ? ` · expires ${new Date(match.expiresAt).toLocaleDateString()}`
                          : ""}
                        {match.documentHash
                          ? ` · hash ${match.documentHash.slice(0, 12)}…`
                          : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {c.draft && (
            <>
              <Separator />
              <Section
                icon={ArrowUpRight}
                title="Draft resolution"
                description="The response draft the workflow prepared for the support team."
              >
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={c.draft.recommendRefund ? "default" : "outline"}
                    >
                      {c.draft.recommendRefund
                        ? `Recommends refund`
                        : "No refund recommended"}
                    </Badge>
                    {c.draft.requiresEscalation && (
                      <Badge variant="destructive">Requires escalation</Badge>
                    )}
                  </div>
                  {c.draft.requiresEscalation && c.draft.escalationReason && (
                    <p className="text-muted-foreground">
                      {c.draft.escalationReason}
                    </p>
                  )}
                </div>
              </Section>
            </>
          )}
        </TabsContent>

        <TabsContent value="data" className="flex flex-col gap-4">
          <Section
            icon={PackageSearch}
            title="Order"
            description="The order record looked up before deciding on a refund."
          >
            {c.orderLookup?.found && c.orderLookup.order ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Order ID</dt>
                <dd>{c.orderLookup.order.orderId}</dd>
                <dt className="text-muted-foreground">Product</dt>
                <dd>{c.orderLookup.order.product}</dd>
                <dt className="text-muted-foreground">Amount</dt>
                <dd>
                  {c.orderLookup.order.amount} {c.orderLookup.order.currency}
                </dd>
                <dt className="text-muted-foreground">Charges</dt>
                <dd>{c.orderLookup.order.chargeCount}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="capitalize">{c.orderLookup.order.status}</dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">
                No order on file for this customer.
              </p>
            )}
          </Section>

          {c.subscriptionLookup?.found && c.subscriptionLookup.subscription && (
            <>
              <Separator />
              <Section
                icon={Receipt}
                title="Subscription"
                description="Current subscription status for this customer."
              >
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd>{c.subscriptionLookup.subscription.plan}</dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="capitalize">
                    {c.subscriptionLookup.subscription.status}
                  </dd>
                  <dt className="text-muted-foreground">Renews</dt>
                  <dd>
                    {new Date(
                      c.subscriptionLookup.subscription.renewsAt,
                    ).toLocaleDateString()}
                  </dd>
                </dl>
              </Section>
            </>
          )}

          {c.refundHistory && c.refundHistory.refunds.length > 0 && (
            <>
              <Separator />
              <Section
                icon={BadgeCheck}
                title="Prior refunds"
                description="Earlier refunds issued to the same customer."
              >
                <div className="flex flex-col gap-2">
                  {c.refundHistory.refunds.map((r) => (
                    <div
                      key={r.refundId}
                      className="flex justify-between border-b pb-1 last:border-0"
                    >
                      <span>{r.reason}</span>
                      <span className="text-muted-foreground">
                        {r.amount} {r.currency}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </TabsContent>
      </Tabs>

      <Separator />
      <p className="text-xs text-muted-foreground">
        Workflow run: {c.workflowRunId ?? "Not available"} · Last updated{" "}
        {new Date(c.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}
