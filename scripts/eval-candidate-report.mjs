import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const files = (await readdir(new URL("../evals/datasets/", import.meta.url)))
  .filter((file) => file.endsWith(".json"))
  .sort();
const datasets = await Promise.all(
  files.map(async (file) => ({
    file,
    bytes: await readFile(
      new URL(`../evals/datasets/${file}`, import.meta.url),
    ),
  })),
);
const datasetHashes = Object.fromEntries(
  datasets.map(({ file, bytes }) => [
    file,
    createHash("sha256").update(bytes).digest("hex"),
  ]),
);
const implementationSha = process.env.GIT_SHA ?? "working-tree";
const report = {
  kind: "support-eval-candidate",
  runner: "deterministic-native-targets-v1",
  executionMode: "deterministic",
  implementationSha,
  datasetHashes,
  reportHash: createHash("sha256")
    .update(
      JSON.stringify({
        implementationSha,
        datasetHashes,
        runner: "deterministic-native-targets-v1",
      }),
    )
    .digest("hex"),
  regression: "pending-human-baseline-approval",
  approvalRequired: [
    "reportHash",
    "datasetHashes",
    "runner",
    "implementationSha",
    "executionMode",
    "perCaseScores",
    "sixAxisScores",
  ],
};
console.log(JSON.stringify(report, null, 2));
