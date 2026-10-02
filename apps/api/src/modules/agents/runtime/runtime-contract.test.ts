import { describeRuntimeContract } from "./contract.ts";
import { legacyResponsesRuntime } from "./legacy-responses.ts";
import { openAiAgentsRuntime } from "./openai-agents.ts";

describeRuntimeContract("legacy_responses", legacyResponsesRuntime);
describeRuntimeContract("openai_agents_sdk", openAiAgentsRuntime);
