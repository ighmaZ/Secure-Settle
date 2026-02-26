import type { WorkflowConfig } from "./types";

export type TriggerEvent =
  | { type: "cron"; id: string; firedAt: string }
  | { type: "evm-log"; id: string; chainId: number; txHash: string; firedAt: string };

export function createCronTriggerEvent(id = "proposal-scan"): TriggerEvent {
  return {
    type: "cron",
    id,
    firedAt: new Date().toISOString()
  };
}

export function isCronDue(
  lastRunAt: Date | null,
  now: Date,
  config: WorkflowConfig
): boolean {
  if (!lastRunAt) return true;
  const elapsedMs = now.getTime() - lastRunAt.getTime();
  return elapsedMs >= config.matching.scanIntervalSeconds * 1000;
}

