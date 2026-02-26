import { cre, Runner, type CronPayload, type Runtime as CreRuntime } from "@chainlink/cre-sdk";
import {
  createConfidentialComputeAdapter,
  createHttpConfidentialComputeAdapter
} from "./confidential";
import { createConvergenceAdapter } from "./convergence";
import { createCreJsonHttpRequester } from "./cre-http";
import { assertSecurityMaterialResolved, resolveSecurityMaterialFromSecrets } from "./security-material";
import { createInMemoryStore } from "./store-memory";
import type { TriggerEvent } from "./triggers";
import {
  WorkflowConfigSchema,
  type RuntimeLike,
  type WorkflowConfig,
  type WorkflowConfigInput
} from "./types";
import { runCronCycle } from "./workflow-core";

const CRON_TRIGGER_ID = "proposal-scan";
const BOOTSTRAP_ADAPTER_WARNING =
  "SecureSettle CRE workflow is running with bootstrap adapters (in-memory store + stub/live-toggle integrations).";

function buildCronScheduleFromSeconds(intervalSeconds: number): string {
  if (intervalSeconds <= 0) {
    throw new Error(`Invalid scan interval seconds: ${intervalSeconds}`);
  }

  // Support sub-minute schedules when the interval divides 60 exactly.
  if (intervalSeconds < 60 && 60 % intervalSeconds === 0) {
    return `*/${intervalSeconds} * * * * *`;
  }

  // Support minute-based schedules when the interval divides 60 minutes exactly.
  if (intervalSeconds % 60 === 0) {
    const intervalMinutes = intervalSeconds / 60;
    if (intervalMinutes <= 60 && 60 % intervalMinutes === 0) {
      return `0 */${intervalMinutes} * * * *`;
    }
  }

  throw new Error(
    `Unsupported matching.scanIntervalSeconds=${intervalSeconds}. Use a divisor of 60s or a whole-minute interval that divides 60m.`
  );
}

function stringifyLogMetadata(metadata: unknown): string {
  try {
    return JSON.stringify(metadata);
  } catch {
    return String(metadata);
  }
}

function createWorkflowLogger(runtime: CreRuntime<WorkflowConfig>): RuntimeLike {
  return {
    log(message, details) {
      runtime.log(details === undefined ? message : `${message} ${stringifyLogMetadata(details)}`);
    }
  };
}

function cronPayloadToTriggerEvent(
  payload: CronPayload,
  runtime: CreRuntime<WorkflowConfig>
): TriggerEvent {
  const scheduledTime = payload.scheduledExecutionTime;
  if (scheduledTime?.seconds !== undefined) {
    const timestampMs =
      Number(scheduledTime.seconds) * 1000 + Math.floor((scheduledTime.nanos ?? 0) / 1_000_000);
    return {
      type: "cron",
      id: CRON_TRIGGER_ID,
      firedAt: new Date(timestampMs).toISOString()
    };
  }

  // Fallback for older payload shapes / local simulation quirks.
  return {
    type: "cron",
    id: CRON_TRIGGER_ID,
    firedAt: runtime.now().toISOString()
  };
}

function readOptionalSecret(runtime: CreRuntime<WorkflowConfig>, secretId: string | null): string | undefined {
  if (!secretId) return undefined;

  const secret = runtime.getSecret({ id: secretId }).result();
  if (!secret.value) {
    throw new Error(`Secret '${secretId}' is empty`);
  }
  return secret.value;
}

function resolveRuntimeConfigWithSecrets(runtime: CreRuntime<WorkflowConfig>): WorkflowConfig {
  return resolveSecurityMaterialFromSecrets(runtime.config, (secretName) =>
    readOptionalSecret(runtime, secretName)
  );
}

function ensureBootstrapAdaptersAllowed(config: WorkflowConfig): void {
  if (config.demo.allowBootstrapAdapters) {
    return;
  }

  throw new Error(
    "Bootstrap CRE adapters are disabled. Configure durable persistence and production integrations before running this workflow."
  );
}

function buildWorkflowAdapters(runtime: CreRuntime<WorkflowConfig>) {
  const config = resolveRuntimeConfigWithSecrets(runtime);
  assertSecurityMaterialResolved(config);
  ensureBootstrapAdaptersAllowed(config);

  // This path is intentionally safe for CRE runtime execution (no Node fs/path dependencies),
  // but it is not durable persistence. It is a bootstrap path only.
  const store = createInMemoryStore(config, () => runtime.now());
  const sendJsonRequest = createCreJsonHttpRequester(runtime);

  const convergence = createConvergenceAdapter(config, {
    mode: config.convergence.mode,
    sendJsonRequest
  });

  const confidential =
    config.confidentialCompute.mode === "http"
      ? createHttpConfidentialComputeAdapter({
          endpointUrl:
            config.confidentialCompute.endpointUrl ??
            (() => {
              throw new Error(
                "confidentialCompute.mode=http requires confidentialCompute.endpointUrl"
              );
            })(),
          timeoutMs: config.confidentialCompute.timeoutMs,
          authHeader: readOptionalSecret(runtime, config.confidentialCompute.authHeaderSecretName),
          sendJsonRequest
        })
      : createConfidentialComputeAdapter("stub");

  return { config, store, convergence, confidential };
}

export async function onCronTrigger(runtime: CreRuntime<WorkflowConfig>, payload: CronPayload) {
  runtime.log(BOOTSTRAP_ADAPTER_WARNING);
  const adapters = buildWorkflowAdapters(runtime);

  const result = await runCronCycle({
    config: adapters.config,
    trigger: cronPayloadToTriggerEvent(payload, runtime),
    runtime: createWorkflowLogger(runtime),
    store: adapters.store,
    convergence: adapters.convergence,
    confidential: adapters.confidential
  });

  return `Processed ${result.processedCandidates} candidate(s), produced ${result.results.length} attested result(s)`;
}

export async function onEvmLogTrigger(_payload: unknown) {
  throw new Error("EVM log trigger handling is not implemented yet.");
}

function initWorkflow(config: WorkflowConfig) {
  const cronCapability = new cre.capabilities.CronCapability();
  const schedule = buildCronScheduleFromSeconds(config.matching.scanIntervalSeconds);

  return [cre.handler(cronCapability.trigger({ schedule }), onCronTrigger)];
}

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig, WorkflowConfigInput>({
    configSchema: WorkflowConfigSchema
  });

  await runner.run(initWorkflow);
}

// Match the CRE docs/reference repo pattern: this file is the executable workflow entrypoint.
void main();
