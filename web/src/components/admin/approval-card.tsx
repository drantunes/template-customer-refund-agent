import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { SupportCase } from "@/lib/types";

export function ApprovalCard({
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
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const draft = supportCase.draft;
  const commandFingerprint = (
    (supportCase.metadata as Record<string, unknown>).refundCommand as
      { fingerprint?: string } | undefined
  )?.fingerprint;
  if (!draft) return null;

  async function handle(approved: boolean) {
    setPending(approved ? "approve" : "reject");
    try {
      if (!commandFingerprint)
        throw new Error(
          "This approval command is unavailable. Refresh the case.",
        );
      await onDecision(approved, commandFingerprint, note || undefined);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Refund approval requested</CardTitle>
        <CardDescription>
          Reviewing as <span className="font-medium">{approverId}</span>.
          Nothing is charged or refunded until you decide.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Amount</p>
            <p className="font-medium">
              {draft.refundAmount} {draft.refundCurrency}
            </p>
          </div>
          <div className="min-w-52">
            <p className="text-muted-foreground">Immutable command</p>
            <code
              className="block truncate font-medium"
              title={commandFingerprint}
            >
              {commandFingerprint ?? "Unavailable"}
            </code>
          </div>
          <div>
            <p className="text-muted-foreground">Order</p>
            <p className="font-medium">
              {supportCase.orderLookup?.order?.orderId ?? "Not found"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Reason</p>
            <p className="font-medium">{draft.refundReason}</p>
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">Drafted customer reply</p>
          <p className="rounded-md border bg-background p-3 text-sm whitespace-pre-wrap">
            {draft.draftResponse}
          </p>
          {draft.citedSources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {draft.citedSources.map((source) => (
                <Badge key={source} variant="outline">
                  {source}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="approval-note">Internal note</FieldLabel>
            <Textarea
              id="approval-note"
              placeholder="Optional note that will be saved in the case history"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
            <FieldDescription>
              Use this if you want to explain why you approved or rejected the
              recommendation.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div className="flex gap-2">
          <Button onClick={() => handle(true)} disabled={pending !== null}>
            {pending === "approve" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <CheckCircle2 data-icon="inline-start" />
            )}
            Approve refund
          </Button>
          <Button
            onClick={() => handle(false)}
            disabled={pending !== null}
            variant="outline"
          >
            {pending === "reject" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <XCircle data-icon="inline-start" />
            )}
            Reject and escalate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
