import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseFiles: string[] = [];

async function loadCharacterizationRuntime(draft: {
  recommendRefund: boolean;
  requiresEscalation: boolean;
  refundAmount?: number;
}) {
  const databasePath = `/private/tmp/phase001-characterization-${crypto.randomUUID()}.db`;
  databaseFiles.push(
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  );
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.SUPPORT_SOURCE = "mock";
  vi.resetModules();
  vi.doMock("@mastra/core/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mastra/core/llm")>();
    return {
      ...actual,
      ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {
        async doEmbed({ values }: { values: string[] }) {
          return {
            embeddings: values.map(() => Array.from({ length: 1536 }, () => 0)),
          };
        }
      },
    };
  });

  const [
    { mastra },
    { caseStore },
    { mockSupportAdapter },
    { triageAgent },
    { responseAgent },
    { searchSupportKnowledgeTool },
  ] = await Promise.all([
    import("../../src/mastra/index"),
    import("../../src/mastra/lib/case-store"),
    import("../../src/mastra/integrations/mock-support"),
    import("../../src/mastra/agents/triage-agent"),
    import("../../src/mastra/agents/response-agent"),
    import("../../src/mastra/tools/search-support-knowledge"),
  ]);

  vi.spyOn(triageAgent, "generate").mockResolvedValue({
    object: {
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: draft.recommendRefund,
      confidence: 1,
      rationale: "Deterministic characterization double.",
    },
    usage: { inputTokens: 3, outputTokens: 5 },
    response: { modelId: "deterministic/triage" },
  } as never);
  vi.spyOn(responseAgent, "generate").mockResolvedValue({
    object: {
      draftResponse:
        "A deterministic response grounded in the duplicate-charge policy.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: draft.recommendRefund,
      refundAmount: draft.refundAmount,
      refundCurrency: draft.recommendRefund ? "USD" : undefined,
      refundReason: draft.recommendRefund ? "duplicate charge" : undefined,
      requiresEscalation: draft.requiresEscalation,
      escalationReason: draft.requiresEscalation
        ? "Deterministic escalation."
        : undefined,
    },
    usage: { inputTokens: 7, outputTokens: 11 },
    response: { modelId: "deterministic/response" },
  } as never);
  vi.spyOn(searchSupportKnowledgeTool, "execute").mockResolvedValue({
    sources: [
      {
        metadata: {
          title: "Duplicate charge policy",
          source: "duplicate-charge-policy",
          text: "Synthetic policy evidence for characterization.",
        },
        score: 0.99,
      },
    ],
  } as never);

  const normalized = await mockSupportAdapter.normalizeInbound({
    externalId: `characterization-${crypto.randomUUID()}`,
    from: "alex@example.com",
    subject: "I was charged twice",
    body: "Please refund the duplicate subscription charge.",
  });
  const supportCase = await caseStore.create({
    id: `case_${crypto.randomUUID()}`,
    status: "new",
    ...normalized,
  });

  return { mastra, caseStore, searchSupportKnowledgeTool, supportCase };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databaseFiles.splice(0).map((file) => rm(file, { force: true })),
  );
});

describe("resolve support case WIP characterization", () => {
  it("suspends a refund recommendation, then resolves after the existing workflow approval checkpoint", async () => {
    const { mastra, caseStore, searchSupportKnowledgeTool, supportCase } =
      await loadCharacterizationRuntime({
        recommendRefund: true,
        requiresEscalation: false,
        refundAmount: 49,
      });
    const workflow = mastra.getWorkflow("resolveSupportCaseWorkflow");
    const run = await workflow.createRun();

    const suspended = await run.start({
      inputData: { caseId: supportCase.id },
    });
    expect(suspended.status).toBe("suspended");
    expect((await caseStore.get(supportCase.id))?.status).toBe(
      "waiting_approval",
    );
    expect(
      (await caseStore.get(supportCase.id))?.policyMatches?.[0]?.source,
    ).toBe("duplicate-charge-policy");
    const toolContext = vi.mocked(searchSupportKnowledgeTool.execute).mock
      .calls[0]?.[1];
    expect(toolContext).toMatchObject({ mastra });
    expect(toolContext?.requestContext).toBeDefined();
    expect(toolContext?.tracingContext).toBeDefined();

    const resumed = await run.resume({
      step: "request-approval",
      resumeData: { approved: true, approverId: "characterization-approver" },
    });
    expect(resumed.status).toBe("success");
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "resolved",
      approval: { approved: true, approverId: "characterization-approver" },
      refundResult: { amount: 49, status: "executed" },
    });
  });

  it("escalates when the existing approval checkpoint is rejected", async () => {
    const { mastra, caseStore, supportCase } =
      await loadCharacterizationRuntime({
        recommendRefund: true,
        requiresEscalation: false,
        refundAmount: 49,
      });
    const run = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun();

    await run.start({ inputData: { caseId: supportCase.id } });
    const resumed = await run.resume({
      step: "request-approval",
      resumeData: {
        approved: false,
        approverId: "characterization-approver",
        note: "Needs review.",
      },
    });

    expect(resumed.status).toBe("success");
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "escalated",
      approval: { approved: false, approverId: "characterization-approver" },
    });
  });

  it("escalates a deterministic policy decision that does not require a refund", async () => {
    const { mastra, caseStore, supportCase } =
      await loadCharacterizationRuntime({
        recommendRefund: false,
        requiresEscalation: true,
      });
    const run = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun();

    const result = await run.start({ inputData: { caseId: supportCase.id } });

    expect(result.status).toBe("success");
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "escalated",
      escalationReason: "Deterministic escalation.",
    });
  });

  it("reports a failed workflow when the deterministic triage double fails", async () => {
    const { mastra, supportCase } = await loadCharacterizationRuntime({
      recommendRefund: false,
      requiresEscalation: false,
    });
    const { triageAgent } =
      await import("../../src/mastra/agents/triage-agent");
    vi.mocked(triageAgent.generate).mockRejectedValueOnce(
      new Error("Synthetic triage failure."),
    );
    const run = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun();

    const result = await run.start({ inputData: { caseId: supportCase.id } });

    expect(result.status).toBe("failed");
  });

  it("persists an inbound case once and returns the same case for a duplicate event", async () => {
    const { mastra, caseStore } = await loadCharacterizationRuntime({
      recommendRefund: false,
      requiresEscalation: false,
    });
    const workflow = mastra.getWorkflow("ingestSupportCaseWorkflow");
    const payload = {
      externalId: `ingest-${crypto.randomUUID()}`,
      from: "alex@example.com",
      subject: "I was charged twice",
      body: "Please refund the duplicate subscription charge.",
    };

    const first = await (
      await workflow.createRun()
    ).start({ inputData: { payload } });
    const second = await (
      await workflow.createRun()
    ).start({ inputData: { payload } });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(first.result.caseId).toBe(second.result.caseId);
    expect(
      (await caseStore.list()).filter(
        (supportCase) => supportCase.externalId === payload.externalId,
      ),
    ).toHaveLength(1);
    await vi.waitFor(async () => {
      expect((await caseStore.get(first.result.caseId))?.status).toBe(
        "resolved",
      );
    });
  });
});
