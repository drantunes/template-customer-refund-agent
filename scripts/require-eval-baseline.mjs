import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

let approved;
try {
  approved = JSON.parse(
    await readFile(new URL("../evals/approved-baseline.json", import.meta.url)),
  );
} catch {
  console.error(
    "EVAL BASELINE PENDING: run npm run eval:candidate-report and obtain human approval for its exact report before required evals can pass.",
  );
  process.exit(2);
}
const files = (await readdir(new URL("../evals/datasets/", import.meta.url)))
  .filter((file) => file.endsWith(".json"))
  .sort();
const datasetHashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(
          await readFile(new URL(`../evals/datasets/${file}`, import.meta.url)),
        )
        .digest("hex"),
    ]),
  ),
);
const implementationSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const reportHash = createHash("sha256")
  .update(
    JSON.stringify({
      implementationSha,
      datasetHashes,
      runner: "deterministic-native-targets-v1",
    }),
  )
  .digest("hex");
const required = [
  "reportHash",
  "datasetHashes",
  "runner",
  "implementationSha",
  "executionMode",
  "approvedBy",
  "approvedAt",
];
if (
  !required.every(
    (key) =>
      typeof approved[key] === "string" ||
      (key === "datasetHashes" &&
        approved[key] &&
        typeof approved[key] === "object"),
  ) ||
  approved.runner !== "deterministic-native-targets-v1" ||
  approved.executionMode !== "deterministic" ||
  approved.implementationSha !== implementationSha ||
  approved.reportHash !== reportHash ||
  JSON.stringify(approved.datasetHashes) !== JSON.stringify(datasetHashes)
) {
  console.error(
    "EVAL BASELINE INVALID: approval record is missing, corrupt, stale, or incompatible with the current datasets/runner/mode/implementation.",
  );
  process.exit(2);
}
