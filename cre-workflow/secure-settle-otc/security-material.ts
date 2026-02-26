import type { WorkflowConfig } from "./types";

export const LOCAL_ENV_PROPOSAL_ENCRYPTION_KEY = "SECURE_SETTLE_PROPOSAL_ENCRYPTION_KEY_HEX";
export const LOCAL_ENV_ATTESTATION_SIGNING_KEY = "SECURE_SETTLE_ATTESTATION_SIGNING_KEY_HEX";

type SecretReader = (secretName: string) => string | undefined;
type EnvReader = (envName: string) => string | undefined;

function cloneConfig(config: WorkflowConfig): WorkflowConfig {
  return {
    ...config,
    proposalEncryption: { ...config.proposalEncryption },
    attestation: { ...config.attestation }
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function resolveSecurityMaterialFromEnv(
  config: WorkflowConfig,
  readEnv: EnvReader = (name) => process.env[name]
): WorkflowConfig {
  const resolved = cloneConfig(config);

  resolved.proposalEncryption.masterKeyHex = firstNonEmpty(
    config.proposalEncryption.masterKeyHex,
    readEnv(LOCAL_ENV_PROPOSAL_ENCRYPTION_KEY),
    config.proposalEncryption.devFallbackMasterKeyHex
  );

  resolved.attestation.signingKeyHex = firstNonEmpty(
    config.attestation.signingKeyHex,
    readEnv(LOCAL_ENV_ATTESTATION_SIGNING_KEY),
    config.attestation.devFallbackSigningKeyHex
  );

  return resolved;
}

export function resolveSecurityMaterialFromSecrets(
  config: WorkflowConfig,
  readSecret: SecretReader
): WorkflowConfig {
  const resolved = cloneConfig(config);

  resolved.proposalEncryption.masterKeyHex = firstNonEmpty(
    config.proposalEncryption.masterKeyHex,
    config.proposalEncryption.masterKeySecretName
      ? readSecret(config.proposalEncryption.masterKeySecretName)
      : undefined,
    config.proposalEncryption.devFallbackMasterKeyHex
  );

  resolved.attestation.signingKeyHex = firstNonEmpty(
    config.attestation.signingKeyHex,
    config.attestation.signingKeySecretName
      ? readSecret(config.attestation.signingKeySecretName)
      : undefined,
    config.attestation.devFallbackSigningKeyHex
  );

  return resolved;
}

export function requireProposalEncryptionKeyHex(config: WorkflowConfig): string {
  const key = config.proposalEncryption.masterKeyHex;
  if (!key) {
    throw new Error(
      "Missing proposal encryption key. Configure proposalEncryption.masterKeySecretName (CRE) or set SECURE_SETTLE_PROPOSAL_ENCRYPTION_KEY_HEX (local)."
    );
  }
  return key;
}

export function requireAttestationSigningKeyHex(config: WorkflowConfig): string {
  const key = config.attestation.signingKeyHex;
  if (!key) {
    throw new Error(
      "Missing attestation signing key. Configure attestation.signingKeySecretName (CRE) or set SECURE_SETTLE_ATTESTATION_SIGNING_KEY_HEX (local)."
    );
  }
  return key;
}

export function assertSecurityMaterialResolved(config: WorkflowConfig): void {
  requireProposalEncryptionKeyHex(config);
  requireAttestationSigningKeyHex(config);
}
