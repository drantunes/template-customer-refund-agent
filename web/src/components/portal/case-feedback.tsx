import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitCaseFeedback } from "@/lib/api";
import type { SupportSession } from "@/lib/api";
import type { SupportCase } from "@/lib/types";
import { Send, ThumbsDown, ThumbsUp } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Lets the customer rate the resolution once a case is closed. Feeds the "customer feedback"
 * monitoring metric (see `/support/monitoring/summary`) and, best-effort, Mastra's
 * observability feedback API via `POST /support/cases/:caseId/feedback`.
 */
export function CaseFeedback({
  supportCase,
  onSubmitted,
  session,
}: {
  supportCase: SupportCase;
  onSubmitted: (updated: SupportCase) => void;
  session: SupportSession;
}) {
  const mounted = useRef(true);
  const [choosing, setChoosing] = useState<"up" | "down" | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (supportCase.feedback) {
    const RatingIcon =
      supportCase.feedback.rating === "up" ? ThumbsUp : ThumbsDown;
    return (
      <p className="flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
        <RatingIcon className="size-3.5" />
        Thanks for your feedback!
      </p>
    );
  }

  async function submit(rating: "up" | "down") {
    setSubmitting(true);
    try {
      const updated = await submitCaseFeedback(
        supportCase.id,
        rating,
        comment || undefined,
        session,
      );
      if (!mounted.current) return;
      onSubmitted(updated);
      toast.success("Thanks for the feedback!");
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error ? error.message : "Failed to submit feedback",
        );
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">
        Did this resolve your issue?
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={choosing === "up" ? "default" : "outline"}
          onClick={() => setChoosing("up")}
          disabled={submitting}
        >
          <ThumbsUp data-icon="inline-start" />
          Yes
        </Button>
        <Button
          size="sm"
          variant={choosing === "down" ? "default" : "outline"}
          onClick={() => setChoosing("down")}
          disabled={submitting}
        >
          <ThumbsDown data-icon="inline-start" />
          No
        </Button>
      </div>
      {choosing && (
        <div className="flex flex-col gap-2">
          <Textarea
            placeholder="Anything you want to add? (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
          />
          <Button
            size="sm"
            onClick={() => submit(choosing)}
            disabled={submitting}
            className="self-start"
          >
            {submitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Send data-icon="inline-start" />
            )}
            Send feedback
          </Button>
        </div>
      )}
    </div>
  );
}
