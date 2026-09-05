import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * This is intentionally an application-process secret, rather than case
 * metadata. A case's durable decision permits native recovery, but cannot be
 * replayed by an HTTP client as a financial bearer credential.
 */
const signingKey = randomBytes(32);
const MAX_AGE_MS = 60_000;

export interface NativeRefundExecutionAuthorization {
  readonly issuedAt: number;
  readonly nativeRunId: string;
  readonly nativeToolCallId: string;
  readonly commandFingerprint: string;
  readonly signature: string;
}

type NativeAgentContext = {
  agent?: { agentId?: string; toolCallId?: string };
};
type NativeApproval = {
  runId?: string;
  toolCallId?: string;
  fingerprint?: string;
};

function payload(value: Omit<NativeRefundExecutionAuthorization, "signature">) {
  return `${value.issuedAt}:${value.nativeRunId}:${value.nativeToolCallId}:${value.commandFingerprint}`;
}

function signature(
  value: Omit<NativeRefundExecutionAuthorization, "signature">,
) {
  return createHmac("sha256", signingKey)
    .update(payload(value))
    .digest("base64url");
}

/**
 * Mints an authorization only inside the registered native tool execution.
 * Callers provide a callback, so no reusable token-minting API is exposed to
 * HTTP routes or other application surfaces.
 */
export async function withNativeRefundExecutionAuthorization<T>(
  context: NativeAgentContext | undefined,
  native: NativeApproval | undefined,
  commandFingerprint: string,
  execute: (authorization: NativeRefundExecutionAuthorization) => Promise<T>,
): Promise<T> {
  if (
    context?.agent?.agentId !== "refund-execution-agent" ||
    !native?.runId ||
    !native.toolCallId ||
    context.agent.toolCallId !== native.toolCallId ||
    native.fingerprint !== commandFingerprint
  )
    throw new Error(
      "Refund execution requires the approved native refund agent tool context.",
    );
  const unsigned = {
    issuedAt: Date.now(),
    nativeRunId: native.runId,
    nativeToolCallId: native.toolCallId,
    commandFingerprint,
  };
  return execute({ ...unsigned, signature: signature(unsigned) });
}

export function hasNativeRefundExecutionAuthorization(
  value: unknown,
  expected: {
    nativeRunId: string;
    nativeToolCallId: string;
    commandFingerprint: string;
  },
): value is NativeRefundExecutionAuthorization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NativeRefundExecutionAuthorization>;
  if (
    typeof candidate.issuedAt !== "number" ||
    !Number.isSafeInteger(candidate.issuedAt) ||
    typeof candidate.signature !== "string" ||
    candidate.nativeRunId !== expected.nativeRunId ||
    candidate.nativeToolCallId !== expected.nativeToolCallId ||
    candidate.commandFingerprint !== expected.commandFingerprint ||
    Math.abs(Date.now() - candidate.issuedAt) > MAX_AGE_MS
  )
    return false;
  const unsigned = {
    issuedAt: candidate.issuedAt,
    nativeRunId: candidate.nativeRunId,
    nativeToolCallId: candidate.nativeToolCallId,
    commandFingerprint: candidate.commandFingerprint,
  };
  const supplied = Buffer.from(candidate.signature);
  const expectedSignature = Buffer.from(signature(unsigned));
  return (
    supplied.length === expectedSignature.length &&
    timingSafeEqual(supplied, expectedSignature)
  );
}
