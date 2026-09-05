import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runtimeCheck = new URL("../../scripts/check-runtime.mjs", import.meta.url)
  .pathname;

describe("runtime gate", () => {
  it("accepts the approved npm and Node.js versions", async () => {
    await expect(
      execFileAsync(process.execPath, [runtimeCheck], {
        env: {
          ...process.env,
          npm_config_user_agent: "npm/11.19.0 node/v24.20.0 darwin arm64",
        },
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("Runtime verified"),
    });
  });

  it("fails when npm reports a version outside the approved pin", async () => {
    await expect(
      execFileAsync(process.execPath, [runtimeCheck], {
        env: {
          ...process.env,
          npm_config_user_agent: "npm/11.18.0 node/v24.20.0 darwin arm64",
        },
      }),
    ).rejects.toThrow("Expected npm 11.19.0");
  });
});
