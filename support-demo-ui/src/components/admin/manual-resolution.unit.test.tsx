import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualResolution } from "./manual-resolution";

describe("ManualResolution", () => {
  it("renders a durable receipt without another submission control", () => {
    const html = renderToStaticMarkup(
      <ManualResolution
        context={{
          version: 2,
          receipt: {
            id: "manual-synthetic",
            actorId: "support-agent-demo",
            turnId: "turn-synthetic",
            createdAt: "2026-09-11T12:00:00.000Z",
            noteState: "delivered",
            closeState: "uncertain",
          },
        }}
        onResolve={async () => undefined}
      />,
    );
    expect(html).toContain("Manual resolution recorded");
    expect(html).toContain("Note delivery: delivered");
    expect(html).toContain("close delivery: uncertain");
    expect(html).not.toContain("Record note and close");
  });
});
