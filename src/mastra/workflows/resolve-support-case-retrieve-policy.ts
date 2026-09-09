import { createStep } from "@mastra/core/workflows";
import type { PolicyMatch } from "../domain/support-case";
import { caseStore } from "../lib/case-store";
import { publishKnowledge } from "../lib/publish-knowledge";
import { traceOperationalPort } from "../lib/operational-spans";
import { withTrustedCaseReadScope } from "../lib/trusted-run-scope";
import { resolveConfiguredBinding } from "../providers/registry";
import { bindingsForPersistedCase } from "../runtime/provider-bindings";
import {
  getActiveCaseOrThrow,
  resolveSupportCaseInputSchema,
} from "./resolve-support-case-context";

export const retrievePolicyStep = createStep({
  id: "retrieve-policy",
  description:
    "Searches the indexed policy knowledge base for context relevant to this case.",
  inputSchema: resolveSupportCaseInputSchema,
  outputSchema: resolveSupportCaseInputSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, turn } = await getActiveCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const bindings = bindingsForPersistedCase(supportCase);
    if (!supportCase.metadata.ownerId)
      throw new Error("The active support case is missing its owner.");
    const queryText =
      `${supportCase.triage?.intent ?? ""} ${supportCase.subject} ${turn.message!.body}`.trim();
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );
    const searchTool = mastra.getTool("searchSupportKnowledgeTool");
    if (!searchTool.execute)
      throw new Error(
        "Registered search_support_knowledge tool has no execute function.",
      );
    await publishKnowledge(bindings.knowledge, {
      onlyIfMissing: true,
      mastra,
      tracingContext,
    });
    const result = await withTrustedCaseReadScope(
      {
        caseId: supportCase.id,
        ownerId: supportCase.metadata.ownerId,
        tenantId: bindings.knowledge.tenantId,
      },
      () =>
        traceOperationalPort({
          mastra,
          tracingContext,
          kind: "tool",
          operation: "tool.search_support_knowledge",
          run: () =>
            searchTool.execute!(
              {
                queryText,
                topK: 5,
                binding: resolveConfiguredBinding(bindings.knowledge),
              },
              { mastra, requestContext, tracingContext },
            ),
        }),
    );
    const sources: Array<{
      metadata?: Record<string, unknown>;
      document?: string;
      score?: number;
    }> =
      result && "sources" in result && Array.isArray(result.sources)
        ? (result.sources as Array<{
            metadata?: Record<string, unknown>;
            document?: string;
            score?: number;
          }>)
        : [];
    const policyMatches: PolicyMatch[] = sources.map((source) => ({
      title: String(source.metadata?.title ?? "Untitled policy"),
      text: String(source.metadata?.text ?? source.document ?? ""),
      source: String(source.metadata?.source ?? "unknown"),
      score: source.score ?? 0,
      version:
        typeof source.metadata?.version === "string"
          ? source.metadata.version
          : undefined,
      documentHash:
        typeof source.metadata?.documentHash === "string"
          ? source.metadata.documentHash
          : undefined,
      generationId:
        typeof source.metadata?.generationId === "string"
          ? source.metadata.generationId
          : undefined,
      effectiveAt:
        typeof source.metadata?.effectiveAt === "string"
          ? source.metadata.effectiveAt
          : undefined,
      indexedAt:
        typeof source.metadata?.indexedAt === "string"
          ? source.metadata.indexedAt
          : undefined,
      expiresAt:
        typeof source.metadata?.expiresAt === "string"
          ? source.metadata.expiresAt
          : undefined,
      providerKind:
        typeof source.metadata?.providerKind === "string"
          ? source.metadata.providerKind
          : undefined,
      providerAccountId:
        typeof source.metadata?.providerAccountId === "string"
          ? source.metadata.providerAccountId
          : undefined,
    }));
    await caseStore.update(supportCase.id, { policyMatches });
    return { caseId: supportCase.id, turnId: inputData.turnId };
  },
});
