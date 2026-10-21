// Writes the published Customer Context v1 artifacts (JSON Schemas and the
// provider OpenAPI document) from the zod source. See ADR 0011.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCustomerContextContract,
  contractText,
  CUSTOMER_CONTEXT_CONTRACT_DIR,
} from "../packages/schemas/src/customer-context-contract.ts";

const examplesDir = join(CUSTOMER_CONTEXT_CONTRACT_DIR, "examples");
const examples = Object.fromEntries(
  readdirSync(examplesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name.replace(/\.json$/, ""),
      JSON.parse(readFileSync(join(examplesDir, name), "utf8")),
    ]),
);
for (const [name, value] of Object.entries(
  buildCustomerContextContract(examples),
))
  writeFileSync(join(CUSTOMER_CONTEXT_CONTRACT_DIR, name), contractText(value));
console.log(
  `Customer context contract written to ${CUSTOMER_CONTEXT_CONTRACT_DIR}`,
);
