import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  reportHash,
  validateEvalReference,
} from "../../scripts/eval-baseline-record.mjs";

function measuredReference() {
  return JSON.parse(
    readFileSync(
      new URL("../../evals/initial-reference.json", import.meta.url),
      "utf8",
    ),
  );
}
function rehash(record: Record<string, unknown>) {
  record.reportHash = reportHash(record);
  return record;
}
function rehashEvidence(record: {
  perCaseScores: Array<{
    evidence: { summary: unknown; evidenceHash: string };
  }>;
  evidenceHash: string;
}) {
  for (const item of record.perCaseScores)
    for (const call of (
      item.evidence.summary as {
        toolCalls?: Array<{ result: unknown; rawResultHash: string }>;
      }
    ).toolCalls ?? [])
      call.rawResultHash = createHash("sha256")
        .update(JSON.stringify(call.result))
        .digest("hex");
  for (const item of record.perCaseScores)
    item.evidence.evidenceHash = createHash("sha256")
      .update(JSON.stringify(item.evidence.summary))
      .digest("hex");
  record.evidenceHash = createHash("sha256")
    .update(JSON.stringify(record.perCaseScores))
    .digest("hex");
  return record;
}

describe("immutable eval reference records", () => {
  it("accepts the measured first reference without inventing a human approval", () => {
    expect(
      validateEvalReference(measuredReference(), { initial: true }),
    ).toMatchObject({ initialReference: true, historicalComparison: null });
  });

  it("rejects removed coverage, altered critical classifications, empty evidence, and fabricated aggregates", () => {
    const missing = measuredReference();
    missing.perCaseScores.pop();
    expect(() => validateEvalReference(rehash(missing))).toThrow("cover every");

    const critical = measuredReference();
    critical.perCaseScores.find(
      (item: { critical: boolean }) => item.critical,
    ).critical = false;
    expect(() => validateEvalReference(rehash(critical))).toThrow(
      "critical coverage",
    );

    const evidence = measuredReference();
    evidence.perCaseScores[0].evidence.summary = {};
    evidence.perCaseScores[0].evidence.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(evidence))).toThrow(
      "invalid, duplicate, or unevidenced",
    );

    const aggregate = measuredReference();
    aggregate.sixAxisScores.groundedness = 0;
    expect(() => validateEvalReference(rehash(aggregate))).toThrow(
      "aggregates",
    );
  });

  it("rejects rehashed placeholder execution summaries and recomputed aggregate hashes", () => {
    const placeholder = measuredReference();
    for (const item of placeholder.perCaseScores) {
      item.evidence.summary = { placeholder: true };
      item.evidence.evidenceHash = "0".repeat(64);
    }
    placeholder.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(placeholder))).toThrow(
      "invalid, duplicate, or unevidenced",
    );

    const aggregate = measuredReference();
    aggregate.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(aggregate))).toThrow(
      "usage or execution evidence",
    );
  });

  it("rejects rehashed contradictory measurements, scorer identities, and assertion results", () => {
    const contradictory = measuredReference();
    contradictory.perCaseScores[0].evidence.summary.score = 0;
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(contradictory))),
    ).toThrow("invalid, duplicate, or unevidenced");

    const wrongScorer = measuredReference();
    wrongScorer.perCaseScores[0].evidence.summary.scorerId = "wrong-scorer";
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(wrongScorer))),
    ).toThrow("invalid, duplicate, or unevidenced");

    const failedAssertion = measuredReference();
    failedAssertion.perCaseScores[0].evidence.summary.assertions = {
      requiresCitation: false,
    };
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(failedAssertion))),
    ).toThrow("invalid, duplicate, or unevidenced");
  });

  it("replays every declared assertion and scorer formula from rehashed observations", () => {
    const mutate = (
      id: string,
      apply: (summary: Record<string, unknown>) => void,
    ) => {
      const record = measuredReference();
      const item = record.perCaseScores.find(
        (caseScore: { id: string }) => caseScore.id === id,
      );
      if (!item) throw new Error(`Missing fixed dataset case ${id}`);
      apply(item.evidence.summary);
      expect(() =>
        validateEvalReference(rehash(rehashEvidence(record))),
      ).toThrow("invalid, duplicate, or unevidenced");
    };

    mutate("adversarial-routing", (summary) => {
      (
        summary.modelOutputs as { triage: { requiresHumanReview: boolean } }
      ).triage.requiresHumanReview = false;
    });
    mutate("lookup-before-refund", (summary) => {
      summary.caseId = "wrong-summary-case";
    });
    mutate("workflow-guard-mutation", (summary) => {
      const workflow = summary.workflow as {
        guarded: boolean;
        status: string;
      };
      workflow.guarded = false;
      workflow.status = "resolved";
      (
        summary.modelOutputs as { draft: { recommendRefund: boolean } }
      ).draft.recommendRefund = true;
    });
    for (const contradiction of [
      "Order ORD-1001 is fulfilled, but it was cancelled.",
      "Order ORD-1001 is fulfilled, but it is unfulfilled.",
      "Order ORD-1001 is fulfilled, but it is not fulfilled.",
      "Order ORD-1001 is fulfilled, but it is no longer fulfilled.",
      "Order ORD-1001 is fulfilled, but not fulfilled.",
      "Order ORD-1001 is fulfilled; actually its status is pending.",
      "It is false that Order ORD-1001 is fulfilled.",
      "Order ORD-1001 is fulfilled; it has never been fulfilled.",
    ])
      mutate("follow-up-stays-scoped", (summary) => {
        (
          summary.modelOutputs as { turns: Array<{ answer: string }> }
        ).turns[1].answer = contradiction;
      });
    for (const contradiction of [
      "Order ORD-1001 is fulfilled; actually its status is pending.",
      "It is false that Order ORD-1001 is fulfilled.",
      "Order ORD-1001 is fulfilled; it has never been fulfilled.",
    ])
      mutate("clear-resolution", (summary) => {
        (
          summary.modelOutputs as { draft: { draftResponse: string } }
        ).draft.draftResponse = contradiction;
      });
    mutate("follow-up-stays-scoped", (summary) => {
      (
        summary.modelOutputs as { turns: Array<{ turn: number }> }
      ).turns[1].turn = 1;
    });
    mutate("follow-up-stays-scoped", (summary) => {
      (summary.modelOutputs as { turns: Array<{ turn: number }> }).turns.pop();
    });
    mutate("follow-up-stays-scoped", (summary) => {
      const turns = (
        summary.modelOutputs as {
          turns: Array<{ turn: number; answer: string }>;
        }
      ).turns;
      turns.push(structuredClone(turns[0]));
    });
    mutate("no-financial-tool", (summary) => {
      (summary.toolCalls as Array<Record<string, unknown>>).push({
        sequence: 5,
        turn: 3,
        name: "issue_refund",
        input: {},
        result: {},
        rawResultHash: "0".repeat(64),
      });
    });
    const toolCalls = (summary: Record<string, unknown>) =>
      summary.toolCalls as Array<{
        input: Record<string, unknown>;
        result: Record<string, unknown>;
      }>;
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[2].input.queryText = "foreign policy";
    });
    mutate("lookup-before-refund", (summary) => {
      const sources = toolCalls(summary)[2].result.sources as Array<{
        metadata: Record<string, unknown>;
      }>;
      sources[0].metadata.documentHash = "0".repeat(64);
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[3].input.customerEmail = "mallory@example.com";
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[3].input.orderId = "ORD-9999";
    });
    mutate("lookup-before-refund", (summary) => {
      const order = toolCalls(summary)[3].result.order as Record<
        string,
        unknown
      >;
      order.customerEmail = "mallory@example.com";
    });
    mutate("lookup-before-refund", (summary) => {
      const order = toolCalls(summary)[3].result.order as Record<
        string,
        unknown
      >;
      order.status = "cancelled";
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[2].result = { sources: [{}] };
    });
    mutate("lookup-before-refund", (summary) => {
      delete (toolCalls(summary)[3].result as { order?: unknown }).order;
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary).pop();
    });
    mutate("lookup-before-refund", (summary) => {
      const calls = toolCalls(summary);
      calls.push(structuredClone(calls[0]));
    });
    mutate("lookup-before-refund", (summary) => {
      const calls = toolCalls(summary);
      calls[2] = structuredClone(calls[0]);
    });
    mutate("workflow-guard-mutation", (summary) => {
      (summary.workflow as { guarded: boolean }).guarded = false;
    });
    for (const id of [
      "unsupported-policy",
      "evidence-required",
      "insufficient-evidence",
    ]) {
      mutate(id, (summary) => {
        delete (summary.modelOutputs as { draft: { draftResponse?: string } })
          .draft.draftResponse;
      });
      mutate(id, (summary) => {
        (
          summary.modelOutputs as { draft: { draftResponse: unknown } }
        ).draft.draftResponse = 7;
      });
      mutate(id, (summary) => {
        (
          summary.modelOutputs as { draft: { draftResponse: string } }
        ).draft.draftResponse =
          "Your refund was issued. No support review is needed.";
      });
      mutate(id, (summary) => {
        (summary.workflow as { finalResponse: string }).finalResponse =
          "Your refund was issued. No support review is needed.";
      });
      mutate(id, (summary) => {
        (summary.workflow as { outboxBodies: string[] }).outboxBodies = [
          "Your refund was issued. No support review is needed.",
        ];
      });
    }
    for (const mutateBinding of [
      (calls: Array<{ input: Record<string, unknown> }>) => {
        calls[0].input.binding = { tenantId: "foreign" };
      },
      (calls: Array<{ input: Record<string, unknown> }>) => {
        calls[1].input.binding = {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "wrong-account",
          externalConversationId: "phase004-eval-conversation",
        };
      },
      (calls: Array<{ input: Record<string, unknown> }>) => {
        calls[2].input.binding = {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "wrong-account",
          externalConversationId: "phase004-eval-conversation",
        };
      },
      (calls: Array<{ input: Record<string, unknown> }>) => {
        calls[3].input.binding = {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "wrong-account",
          externalConversationId: "phase004-eval-conversation",
        };
      },
      (calls: Array<{ input: Record<string, unknown> }>) => {
        calls[2].input.untrusted = "extra";
      },
    ])
      mutate("lookup-before-refund", (summary) =>
        mutateBinding(toolCalls(summary)),
      );
    for (const mutateSource of [
      (sources: Array<Record<string, unknown>>) =>
        sources.push(structuredClone(sources[0])),
      (sources: Array<Record<string, unknown>>) =>
        sources.push({
          title: "Foreign policy",
          source: "foreign-policy",
          documentHash: "a".repeat(64),
        }),
      (sources: Array<Record<string, unknown>>) => {
        sources[0] = {};
      },
      (sources: Array<Record<string, unknown>>) => {
        sources[0].untrusted = "extra";
      },
    ])
      mutate("lookup-before-refund", (summary) =>
        mutateSource(
          toolCalls(summary)[2].result.sources as Array<
            Record<string, unknown>
          >,
        ),
      );
    const completeSource = (summary: Record<string, unknown>) =>
      (
        toolCalls(summary)[2].result.sources as Array<{
          document: string;
          metadata: Record<string, unknown>;
        }>
      )[0];
    const switchExactAuthority = (
      summary: Record<string, unknown>,
      index: 2 | 3,
    ) => {
      toolCalls(summary)[index].input.binding = {
        tenantId: "local-demo",
        providerKind: "local",
        providerAccountId: "phase004-eval-authority-lookup-before-refund-other",
        externalConversationId:
          "phase004-eval-conversation-lookup-before-refund-other",
      };
    };
    for (const apply of [
      (summary: Record<string, unknown>) => switchExactAuthority(summary, 2),
      (summary: Record<string, unknown>) => switchExactAuthority(summary, 3),
      (summary: Record<string, unknown>) => {
        completeSource(summary).document = "Refunds are unconditional.";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.text = "Refunds are unconditional.";
      },
      (summary: Record<string, unknown>) => {
        const entry = completeSource(summary);
        entry.document = "Attacker-controlled replacement.";
        entry.metadata.text = entry.document;
      },
      (summary: Record<string, unknown>) => {
        const entry = completeSource(summary);
        entry.document = "Attacker-controlled replacement.";
        entry.metadata.text = entry.document;
        entry.metadata.documentHash = createHash("sha256")
          .update(
            JSON.stringify([
              "duplicate-charge-policy",
              "local-v1",
              entry.document,
            ]),
          )
          .digest("hex");
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.version = "invented-v99";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.generationId =
          "knowledge_11111111-1111-4111-8111-111111111111";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.effectiveAt = "not-a-date";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.indexedAt = "2026-01-01T00:00:00Z";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.expiresAt = "2026-01-01T00:00:00.000Z";
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.providerAccountId = "foreign-account";
      },
      (summary: Record<string, unknown>) => {
        const documentHash = completeSource(summary).metadata.documentHash;
        toolCalls(summary)[2].result = {
          sources: [
            {
              title: "Duplicate Charge Policy",
              source: "duplicate-charge-policy",
              documentHash,
            },
          ],
        };
      },
      (summary: Record<string, unknown>) => {
        delete completeSource(summary).metadata.version;
      },
      (summary: Record<string, unknown>) => {
        completeSource(summary).metadata.untrusted = true;
      },
      (summary: Record<string, unknown>) => {
        const calls = toolCalls(summary);
        (calls[2].result.sources as Array<Record<string, unknown>>).push(
          structuredClone(completeSource(summary)),
        );
      },
    ])
      mutate("lookup-before-refund", apply);
    const sourceAt = (summary: Record<string, unknown>, index: 0 | 2) =>
      (
        toolCalls(summary)[index].result.sources as Array<{
          metadata: Record<string, unknown>;
        }>
      )[0].metadata;
    const orderAt = (summary: Record<string, unknown>, index: 1 | 3) =>
      toolCalls(summary)[index].result.order as Record<string, unknown>;
    // Every replay probe refreshes raw result, per-case evidence, aggregate
    // evidence, and report hashes through mutate(), proving semantic rather
    // than stale-hash rejection for the observed review-8 families.
    for (const apply of [
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 0).expiresAt = "2026-01-01T00:00:01.000Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 0).expiresAt = "2026-01-01T00:00:00.500Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 2).expiresAt = "2026-01-01T00:00:03.000Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 0).expiresAt = "2026-01-01T00:00:03.000Z";
        sourceAt(summary, 2).expiresAt = "2026-01-01T00:00:04.000Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 2).indexedAt = "2026-01-01T00:00:01.500Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 0).indexedAt = "2026-01-01T00:00:03.000Z";
        sourceAt(summary, 2).indexedAt = "2026-01-01T00:00:03.000Z";
      },
      (summary: Record<string, unknown>) => {
        sourceAt(summary, 0).generationId =
          "knowledge_11111111-1111-4111-8111-111111111111";
        sourceAt(summary, 2).generationId =
          "knowledge_11111111-1111-4111-8111-111111111111";
      },
    ])
      mutate("lookup-before-refund", apply);
    for (const [key, value] of [
      ["amount", 1],
      ["currency", "BTC"],
      ["product", "Tampered Plan"],
      ["chargeCount", 0],
      ["placedAt", "2026-08-02T14:00:00.000Z"],
    ] as const) {
      mutate("lookup-before-refund", (summary) => {
        orderAt(summary, 3)[key] = value;
      });
      mutate("lookup-before-refund", (summary) => {
        orderAt(summary, 1)[key] = value;
        orderAt(summary, 3)[key] = value;
      });
    }
    for (const apply of [
      (summary: Record<string, unknown>) => {
        delete orderAt(summary, 3).amount;
      },
      (summary: Record<string, unknown>) => {
        orderAt(summary, 3).untrusted = true;
      },
      (summary: Record<string, unknown>) => {
        delete (toolCalls(summary)[3].result as { found?: unknown }).found;
      },
    ])
      mutate("lookup-before-refund", apply);
  });
});
