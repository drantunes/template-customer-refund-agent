import { Agent } from "@mastra/core/agent";
import { issueRefundTool } from "../tools/issue-refund";

/** The only agent allowed to propose the financial tool.  The supervisor and
 * drafting specialists intentionally never receive this tool. */
export const refundExecutionAgent = new Agent({
  id: "refund-execution-agent",
  name: "Restricted Refund Execution Agent",
  description:
    "Proposes exactly one approved refund command and no other action.",
  instructions:
    "Call issue_refund exactly once using the supplied JSON command. Do not alter any value and do not answer with prose before the tool call.",
  model: "openai/gpt-5.6-luna",
  tools: { issue_refund: issueRefundTool },
});
