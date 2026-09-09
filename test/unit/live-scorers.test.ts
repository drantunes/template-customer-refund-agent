import { describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import {
  liveResponseOutputScorer,
  liveTriageOutputScorer,
} from "../../src/mastra/evals";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

describe("live native scorer contracts", () => {
  it("extracts Mastra assistant-message output without ground truth", async () => {
    const output = [
      {
        role: "assistant",
        content: JSON.stringify({
          intent: "order_status",
          requiresHumanReview: false,
          confidence: 0.9,
        }),
      },
    ];
    await expect(liveTriageOutputScorer.run({ output })).resolves.toMatchObject(
      { score: 1 },
    );
    await expect(
      liveResponseOutputScorer.run({ output }),
    ).resolves.toMatchObject({ score: 0 });
  });

  it("runs a registered scorer during native Agent.generate with its run data", async () => {
    const agent = new Agent({
      id: "native-live-scorer-test",
      name: "Native live scorer test",
      instructions: "Return the structured result.",
      model: deterministicJsonModel({
        intent: "order_status",
        requiresHumanReview: false,
        confidence: 0.9,
      }) as never,
      scorers: { outputContract: { scorer: liveTriageOutputScorer } },
    });
    const result = await agent.generate(
      [{ role: "user", content: "where is my order?" }],
      {
        scorers: { outputContract: { scorer: liveTriageOutputScorer } },
        returnScorerData: true,
        runId: "native-live-scorer-run",
      },
    );
    const scoringData = (result as Record<string, unknown>).scoringData as {
      output: unknown;
    };
    expect(result.runId).toBe("native-live-scorer-run");
    expect(scoringData.output).toEqual(expect.any(Array));
    await expect(
      liveTriageOutputScorer.run({ output: scoringData.output }),
    ).resolves.toMatchObject({ score: 1 });
  });
});
