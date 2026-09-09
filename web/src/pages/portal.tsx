import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { CaseFeedback } from "@/components/portal/case-feedback";
import {
  clearSession,
  hasAnyRole,
  isCaseActive,
  listCases,
  SessionExpiredError,
  submitCase,
  submitFollowUp,
  type SupportSession,
} from "@/lib/api";
import { useMountedSession } from "@/lib/mounted-session";
import { SessionLogin } from "@/components/session-login";
import { samplesForPrincipal } from "@/lib/mock-emails";
import type { MockEmailPayload, SupportCase } from "@/lib/types";
import { ArrowUpRight, Plus, RefreshCcw, Send } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export function caseForFollowUp(cases: SupportCase[], selectedCaseId: string) {
  return cases.find((supportCase) => supportCase.id === selectedCaseId);
}

function CaseCard({
  supportCase,
  onCaseUpdated,
  onSessionExpired,
  session,
}: {
  supportCase: SupportCase;
  onCaseUpdated: (updated: SupportCase) => void;
  onSessionExpired: (session: SupportSession) => void;
  session: SupportSession;
}) {
  const lastAgentMessage = [...supportCase.messages]
    .reverse()
    .find((m) => m.author === "agent");
  const isClosed =
    supportCase.status === "resolved" || supportCase.status === "escalated";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{supportCase.subject}</CardTitle>
            <CardDescription>
              Opened {new Date(supportCase.createdAt).toLocaleString()} · Case{" "}
              {supportCase.id}
            </CardDescription>
          </div>
          <StatusBadge status={supportCase.status} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {supportCase.messages.map((message) => (
          <div
            key={message.id}
            className={
              message.author === "customer"
                ? "text-foreground"
                : "text-muted-foreground"
            }
          >
            <span className="font-medium">
              {message.author === "customer" ? "You" : "Support"}:{" "}
            </span>
            {message.body}
          </div>
        ))}
        {isCaseActive(supportCase.status) && !lastAgentMessage && (
          <p className="text-muted-foreground">
            The case is still being processed.
          </p>
        )}
        {supportCase.status === "waiting_approval" && (
          <p className="text-muted-foreground">
            A refund was recommended and is waiting for approval.
          </p>
        )}
        {supportCase.refundResult?.status === "executed" && (
          <p className="text-muted-foreground">
            Refund of {supportCase.refundResult.amount}{" "}
            {supportCase.refundResult.currency} issued.
          </p>
        )}
        {isClosed && (
          <CaseFeedback
            supportCase={supportCase}
            onSubmitted={onCaseUpdated}
            onSessionExpired={onSessionExpired}
            session={session}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function Portal() {
  const { session, setSession, invalidateSession } = useMountedSession();
  if (!session)
    return (
      <SessionLogin
        email="alex@example.com"
        password="local-customer-alex"
        onSession={setSession}
      />
    );
  if (!hasAnyRole(session, ["customer"]))
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground">
          This session cannot access the customer portal.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            clearSession(session);
            setSession(undefined);
          }}
        >
          Switch account
        </Button>
      </div>
    );

  return (
    <PortalSession
      key={session.token}
      session={session}
      onSessionExpired={invalidateSession}
      onSignOut={() => {
        clearSession(session);
        setSession(undefined);
      }}
    />
  );
}

function PortalSession({
  session,
  onSignOut,
  onSessionExpired,
}: {
  session: SupportSession;
  onSignOut: () => void;
  onSessionExpired: (session: SupportSession) => void;
}) {
  const mounted = useRef(true);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const mockEmails = samplesForPrincipal(session.principal.email);
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [loadingCases, setLoadingCases] = useState(true);
  const [view, setView] = useState<"form" | "cases">("form");
  const [nextStepsOpen, setNextStepsOpen] = useState(false);
  const [lastCaseId, setLastCaseId] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [selectedFollowUpCaseId, setSelectedFollowUpCaseId] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshCases = useCallback(async () => {
    setLoadingCases(true);
    try {
      const res = await listCases(session);
      if (!mounted.current) return null;
      setCases(res.cases);
      return res.cases;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(session);
        return null;
      }
      // Keep showing the last known list on transient errors.
      return null;
    } finally {
      if (mounted.current) setLoadingCases(false);
    }
  }, [session, onSessionExpired]);

  useEffect(() => {
    (async () => {
      const result = await refreshCases();
      if (result && result.length > 0) setView("cases");
    })();
  }, [refreshCases]);

  // Poll while any case is still moving through the pipeline.
  useEffect(() => {
    if (!cases.some((c) => isCaseActive(c.status))) return;
    const interval = setInterval(refreshCases, 4000);
    return () => clearInterval(interval);
  }, [cases, refreshCases]);

  useEffect(() => {
    if (
      selectedFollowUpCaseId &&
      !cases.some((c) => c.id === selectedFollowUpCaseId)
    )
      setSelectedFollowUpCaseId("");
  }, [cases, selectedFollowUpCaseId]);

  function applySample(mock: MockEmailPayload) {
    setName(mock.fromName ?? "");
    setSubject(mock.subject ?? "Support request");
    setBody(mock.body);
  }

  async function handleSubmit() {
    if (!subject || !body) return;
    setSubmitting(true);
    try {
      const result = await submitCase(
        {
          externalId: `web-${crypto.randomUUID()}`,
          from: session.principal.email,
          fromName: name || undefined,
          subject,
          body,
        },
        session,
      );
      if (!mounted.current) return;
      setSubject("");
      setBody("");
      setLastCaseId(result.caseId);
      setView("cases");
      setNextStepsOpen(true);
      await refreshCases();
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(session);
        return;
      }
      if (mounted.current)
        toast.error(
          error instanceof Error ? error.message : "Failed to submit case",
        );
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Customer portal
          </h1>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
        <p className="max-w-2xl text-muted-foreground">
          Send a message to support and watch the case status update as the AI
          works on it.
        </p>
      </section>

      {view === "form" ? (
        <Card>
          <CardHeader>
            <CardTitle>Contact support</CardTitle>
            <CardDescription>Send a message to create a case.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <FieldGroup>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="name">Your name</FieldLabel>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Kim"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input id="email" value={session.principal.email} disabled />
                  <FieldDescription>
                    This demo uses one fixed customer account.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <Field>
                <FieldLabel htmlFor="subject">Subject</FieldLabel>
                <Input
                  id="subject"
                  required
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="I was charged twice"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="body">Message</FieldLabel>
                <Textarea
                  id="body"
                  required
                  rows={5}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Tell us what happened"
                />
              </Field>
            </FieldGroup>

            {mockEmails.length > 0 && (
              <Accordion>
                <AccordionItem value="templates">
                  <AccordionTrigger>Or choose a template</AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-0.5">
                      {mockEmails.map((mock) => (
                        <button
                          key={mock.externalId}
                          type="button"
                          onClick={() => applySample(mock)}
                          className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                        >
                          <span className="text-sm font-medium">
                            {mock.subject}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {mock.fromName ?? mock.from}
                          </span>
                        </button>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </CardContent>
          <CardFooter>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Send data-icon="inline-start" />
              )}
              Send message
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Your cases</CardTitle>
              <CardDescription>
                Everything you've sent to support.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshCases()}
                disabled={loadingCases}
              >
                <RefreshCcw data-icon="inline-start" />
                Refresh cases
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setView("form")}
              >
                <Plus data-icon="inline-start" />
                New message
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loadingCases && cases.length === 0 && (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {!loadingCases && cases.length === 0 && (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>No cases yet</EmptyTitle>
                  <EmptyDescription>
                    Send a message to support to start a case.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <div className="flex flex-col gap-3">
              {cases.map((c) => (
                <CaseCard
                  key={c.id}
                  supportCase={c}
                  onCaseUpdated={(updated) =>
                    setCases((prev) =>
                      prev.map((existing) =>
                        existing.id === updated.id ? updated : existing,
                      ),
                    )
                  }
                  onSessionExpired={onSessionExpired}
                  session={session}
                />
              ))}
            </div>
            {cases.length > 0 && (
              <form
                className="flex gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const target = caseForFollowUp(cases, selectedFollowUpCaseId);
                  if (!target || !followUp.trim()) return;
                  try {
                    const updated = await submitFollowUp(
                      target.id,
                      followUp.trim(),
                      session,
                    );
                    if (!mounted.current) return;
                    setCases((previous) =>
                      previous.map((entry) =>
                        entry.id === updated.id ? updated : entry,
                      ),
                    );
                    setFollowUp("");
                  } catch (error) {
                    if (error instanceof SessionExpiredError) {
                      onSessionExpired(session);
                      return;
                    }
                    if (mounted.current)
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Failed to send follow-up",
                      );
                  }
                }}
              >
                <div className="flex flex-1 flex-col gap-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="follow-up-case"
                  >
                    Add a follow-up to
                  </label>
                  <select
                    id="follow-up-case"
                    aria-label="Follow-up case"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={selectedFollowUpCaseId}
                    onChange={(event) =>
                      setSelectedFollowUpCaseId(event.target.value)
                    }
                  >
                    <option value="" disabled>
                      Choose a case
                    </option>
                    {cases.map((supportCase) => (
                      <option key={supportCase.id} value={supportCase.id}>
                        {supportCase.subject} ({supportCase.id})
                      </option>
                    ))}
                  </select>
                  <Textarea
                    aria-label="Follow-up message"
                    value={followUp}
                    onChange={(event) => setFollowUp(event.target.value)}
                    placeholder="Add context to the selected case"
                    rows={2}
                  />
                </div>
                <Button type="submit" variant="outline">
                  Send follow-up
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={nextStepsOpen} onOpenChange={setNextStepsOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Your message is on its way</DialogTitle>
            <DialogDescription>
              An AI agent is now reading your message, checking your order and
              the support policies, and drafting a response. Depending on what
              it finds, it may resolve the case on its own or hand it off to a
              human for approval.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Open the admin dashboard to review this case. Mastra Studio shows
            the registered agent, workflows, and tools; it does not process this
            case or record an approval. Case work and approval stay in the local
            portal and admin dashboard.
          </p>
          <DialogFooter>
            <a
              className={buttonVariants({ variant: "outline" })}
              href="http://localhost:4111"
              target="_blank"
              rel="noreferrer"
            >
              Mastra Studio
              <ArrowUpRight data-icon="inline-end" />
            </a>
            <a
              className={buttonVariants()}
              href={lastCaseId ? `/admin/${lastCaseId}` : "/admin"}
              target="_blank"
              rel="noreferrer"
            >
              Admin dashboard
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
