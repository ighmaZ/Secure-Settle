import { loadConfig } from "./config-node";
import { createLocalFileStore } from "./store";

async function run() {
  const id = process.argv[2];
  if (!id) {
    throw new Error("Usage: bun run status <proposal-id|match-id>");
  }
  const config = await loadConfig();
  const store = createLocalFileStore(config);
  const status = await store.getWorkflowStatus(id);
  if (!status) {
    console.log(`No workflow entity found for id=${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(status, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
