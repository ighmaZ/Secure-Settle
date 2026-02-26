import { runCronCycle } from "./workflow-core";
import { loadConfig } from "./config-node";
import { resolveDataPath } from "./store";
import { createRuntimeLogger } from "./runtime-node";
import { createLocalRuntimeAdapters } from "./local-runtime-factories";

async function run() {
  const args = new Set(process.argv.slice(2));
  const seedOnly = args.has("--seed-only");
  const reset = args.has("--reset");
  const convergenceModeArg = [...args].find((arg) => arg.startsWith("--convergence-mode="));
  const convergenceMode = (convergenceModeArg?.split("=")[1] ?? "stub") as "stub" | "live";
  const simulateUnavailable = [...args].find((arg) => arg.startsWith("--simulate-unavailable="));
  const unavailableWallets = simulateUnavailable
    ? simulateUnavailable.split("=")[1]?.split(",").filter(Boolean) ?? []
    : [];

  const config = await loadConfig();
  const adapters = createLocalRuntimeAdapters(config, {
    confidentialMode: "stub",
    convergenceMode,
    simulateUnavailableWallets: unavailableWallets
  });
  const store = adapters.store;

  if (reset) {
    await store.resetState();
    console.log("Reset local store");
  }

  const seeded = await store.seedDemoProposalsIfEmpty();
  if (seeded) {
    console.log("Seeded demo proposals");
  } else {
    console.log("Demo proposals already present");
  }

  if (seedOnly) {
    console.log(`Store path: ${resolveDataPath(config)}`);
    return;
  }

  const result = await runCronCycle({
    config,
    runtime: createRuntimeLogger(),
    ...adapters
  });

  console.log("\nSimulation result");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nStore path: ${resolveDataPath(config)}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
