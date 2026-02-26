import type { SettlementInstructionBundle } from "./types";

export type EvmSettlementClient = {
  writeReport: (bundle: SettlementInstructionBundle) => Promise<{ txHash: string }>;
};

export function createEvmSettlementClient(): EvmSettlementClient {
  return {
    async writeReport(_bundle) {
      throw new Error("Settlement EVM writes are not implemented in the CRE-first scaffold.");
    }
  };
}

