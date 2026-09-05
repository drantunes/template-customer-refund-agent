import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let baseline;
try {
  baseline = JSON.parse(
    await readFile(new URL("../evals/approved-baseline.json", import.meta.url)),
  );
} catch {
  console.error(
    "EVAL BASELINE PENDING: human approval of a candidate report is required.",
  );
  process.exit(2);
}
const required = [
  "reportHash",
  "datasetHashes",
  "runner",
  "executionMode",
  "implementationSha",
  "approvedBy",
  "approvedAt",
  "sixAxisScores",
  "perCaseScores",
];
if (!required.every((key) => baseline[key] !== undefined)) {
  console.error(
    "EVAL BASELINE INVALID: the human record lacks report provenance or measured scores.",
  );
  process.exit(2);
}
const directory = await mkdtemp(join(tmpdir(), "support-eval-baseline-"));
const candidatePath = join(directory, "candidate.json");
try {
  execFileSync("node", ["scripts/eval-candidate-report.mjs"], {
    stdio: "inherit",
    env: { ...process.env, SUPPORT_EVAL_CANDIDATE_OUTPUT: candidatePath },
  });
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  if (
    candidate.runner !== baseline.runner ||
    candidate.executionMode !== baseline.executionMode ||
    JSON.stringify(candidate.datasetHashes) !==
      JSON.stringify(baseline.datasetHashes)
  ) {
    throw new Error(
      "candidate runner, mode, or dataset identities are incompatible with the approved baseline",
    );
  }
  const floors = {
    groundedness: 0.9,
    "policy-compliance": 0.9,
    "routing-accuracy": 0.9,
    "tool-call-correctness": 0.9,
    "multi-turn-consistency": 0.9,
    "resolution-quality": 0.85,
  };
  for (const [axis, floor] of Object.entries(floors)) {
    const candidateScore = candidate.sixAxisScores[axis];
    const baselineScore = baseline.sixAxisScores[axis];
    if (
      !Number.isFinite(candidateScore) ||
      !Number.isFinite(baselineScore) ||
      candidateScore < floor ||
      candidateScore < baselineScore - 0.02
    )
      throw new Error(`candidate failed ${axis} floor or regression limit`);
  }
  for (const item of candidate.perCaseScores)
    if (item.critical && item.score !== 1)
      throw new Error(`critical case failed: ${item.id}`);
} catch (error) {
  console.error(
    `EVAL BASELINE INVALID: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
} finally {
  await rm(directory, { force: true, recursive: true });
}
