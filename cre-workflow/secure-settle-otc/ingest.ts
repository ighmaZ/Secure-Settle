import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config-node";
import { createLocalFileStore } from "./store";
import { ProposalPayloadSchema } from "./types";

async function loadPayloadFromArgs(args: string[]) {
  const fileArg = args.find((arg) => arg.startsWith("--file="));
  if (fileArg) {
    const filePath = fileArg.slice("--file=".length);
    const resolved = path.resolve(process.cwd(), filePath);
    const raw = await readFile(resolved, "utf8");
    return ProposalPayloadSchema.parse(JSON.parse(raw));
  }

  const jsonArg = args.find((arg) => arg.startsWith("--json="));
  if (jsonArg) {
    return ProposalPayloadSchema.parse(JSON.parse(jsonArg.slice("--json=".length)));
  }

  throw new Error("Provide proposal payload via --file=<path> or --json='<payload>'");
}

async function run() {
  const args = process.argv.slice(2);
  const payload = await loadPayloadFromArgs(args);
  const config = await loadConfig();
  const store = createLocalFileStore(config);
  const proposal = await store.submitProposal(payload);
  console.log(JSON.stringify(proposal, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
