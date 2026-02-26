import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSecurityMaterialFromEnv } from "./security-material";
import { assertSecurityMaterialResolved } from "./security-material";
import { WorkflowConfigSchema, type WorkflowConfig } from "./types";

export function defaultConfigPath(): string {
  return path.resolve(import.meta.dirname, "config.json");
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<WorkflowConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = WorkflowConfigSchema.parse(JSON.parse(raw));
  const resolved = resolveSecurityMaterialFromEnv(parsed);
  assertSecurityMaterialResolved(resolved);
  return resolved;
}
