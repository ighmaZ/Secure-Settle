import {
  EncryptedProposalEnvelopeSchema,
  ProposalPayloadSchema,
  type EncryptedProposalEnvelope,
  type ProposalPayload,
  type WorkflowConfig
} from "./types";
import { aes256GcmDecryptHex, aes256GcmEncryptHex, sha256Hex, stableJson } from "./crypto-primitives";
import { requireProposalEncryptionKeyHex } from "./security-material";

type ProposalEnvelopeAad = {
  proposalId: string;
  walletAddress: string;
  assetId: string;
  settlementToken: string;
  side: "BUY" | "SELL";
  keyId: string;
};

function buildAadJson(input: ProposalEnvelopeAad): string {
  return stableJson(input);
}

export async function encryptProposalPayload(
  config: WorkflowConfig,
  proposalId: string,
  payload: ProposalPayload
): Promise<EncryptedProposalEnvelope> {
  const normalizedPayload = ProposalPayloadSchema.parse(payload);
  const plaintextJson = stableJson(normalizedPayload);
  const plaintextHash = await sha256Hex(plaintextJson);

  const aadJson = buildAadJson({
    proposalId,
    walletAddress: normalizedPayload.walletAddress,
    assetId: normalizedPayload.assetId,
    settlementToken: normalizedPayload.settlementToken,
    side: normalizedPayload.side,
    keyId: config.proposalEncryption.keyId
  });

  const encrypted = await aes256GcmEncryptHex(
    requireProposalEncryptionKeyHex(config),
    plaintextJson,
    aadJson
  );

  return EncryptedProposalEnvelopeSchema.parse({
    version: "v1",
    algorithm: "AES-256-GCM",
    keyId: config.proposalEncryption.keyId,
    ivHex: encrypted.ivHex,
    ciphertextHex: encrypted.ciphertextHex,
    aadJson,
    plaintextHash
  });
}

export async function decryptProposalPayload(
  config: WorkflowConfig,
  envelope: EncryptedProposalEnvelope
): Promise<ProposalPayload> {
  const normalizedEnvelope = EncryptedProposalEnvelopeSchema.parse(envelope);
  const plaintextJson = await aes256GcmDecryptHex(
    requireProposalEncryptionKeyHex(config),
    normalizedEnvelope.ciphertextHex,
    normalizedEnvelope.ivHex,
    normalizedEnvelope.aadJson
  );

  const actualHash = await sha256Hex(plaintextJson);
  if (actualHash.toLowerCase() !== normalizedEnvelope.plaintextHash.toLowerCase()) {
    throw new Error("Encrypted proposal payload hash mismatch");
  }

  return ProposalPayloadSchema.parse(JSON.parse(plaintextJson));
}
