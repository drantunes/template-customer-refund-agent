import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ManualResolutionContext } from "@/lib/api";

export function ManualResolution({
  context,
  onResolve,
}: {
  context: ManualResolutionContext;
  onResolve: (note: string, idempotencyKey: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());
  if (context.receipt)
    return (
      <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3 text-sm">
        <p className="font-medium">Manual resolution recorded</p>
        <p className="text-muted-foreground">
          Note delivery: {context.receipt.noteState} · close delivery:{" "}
          {context.receipt.closeState}
        </p>
      </div>
    );
  if (!context.activeTurnId) return null;
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!note.trim()) return;
        setPending(true);
        try {
          await onResolve(note.trim(), key.current);
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="text-sm font-medium" htmlFor="manual-note">
        Internal resolution note
      </label>
      <textarea
        id="manual-note"
        className="min-h-24 rounded-md border bg-background p-2 text-sm"
        maxLength={4000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        required
      />
      <p className="text-xs text-muted-foreground">
        This records an internal note, then closes the support conversation. It
        does not send a customer reply or approve a financial action.
      </p>
      <Button type="submit" disabled={pending || !note.trim()}>
        {pending ? "Recording…" : "Record note and close"}
      </Button>
    </form>
  );
}
