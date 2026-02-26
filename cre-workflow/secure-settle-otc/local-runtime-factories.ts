import { createConfidentialComputeAdapter } from "./confidential";
import { createConvergenceAdapter } from "./convergence";
import { createLocalFileStore } from "./store";
import type { WorkflowConfig } from "./types";

export type LocalRuntimeFactoryOptions = {
  confidentialMode?: "stub" | "real";
  convergenceMode?: "stub" | "live";
  simulateUnavailableWallets?: string[];
};

export function createLocalRuntimeAdapters(
  config: WorkflowConfig,
  options: LocalRuntimeFactoryOptions = {}
) {
  return {
    store: createLocalFileStore(config),
    convergence: createConvergenceAdapter(config, {
      mode: options.convergenceMode ?? "stub",
      simulateUnavailableWallets: options.simulateUnavailableWallets
    }),
    confidential: createConfidentialComputeAdapter(options.confidentialMode ?? "stub")
  };
}

