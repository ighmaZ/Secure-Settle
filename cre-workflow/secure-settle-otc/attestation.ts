import { deterministicHexHash } from "./hashing";
import { createStubAttestationEvidence } from "./attestation-verify";
import type {
  AttestedMatchResult,
  ComplianceCheckResult,
  ConfidentialChallenge,
  MatchCandidate,
  MatchDecision,
  ProposalPayload,
  ProposalRecord,
  MaskedSummary
} from "./types";
import { AttestedMatchResultSchema, nowIso, type WorkflowConfig } from "./types";

function hashObject(input: unknown): string {
  const payload = JSON.stringify(input);
  return deterministicHexHash(payload);
}

function quantityBand(quantity: number): string {
  if (quantity < 100) return "<100";
  if (quantity < 1000) return "100-999";
  return "1000+";
}

function priceBand(price: number): string {
  const floored = Math.floor(price);
  return `${floored}-${floored + 1}`;
}

export function createMaskedSummary(
  proposalRecord: Pick<ProposalRecord, "id">,
  proposalTerms: ProposalPayload,
  statusMessage: string
): MaskedSummary {
  return {
    proposalId: proposalRecord.id,
    assetId: proposalTerms.assetId,
    side: proposalTerms.side,
    quantityBand: quantityBand(proposalTerms.quantity),
    priceBand: priceBand(proposalTerms.price),
    settlementToken: proposalTerms.settlementToken,
    statusMessage
  };
}

export type AttestationInput = {
  config: WorkflowConfig;
  candidate: MatchCandidate;
  buyProposal: ProposalRecord;
  sellProposal: ProposalRecord;
  buyTerms: ProposalPayload;
  sellTerms: ProposalPayload;
  challenge: ConfidentialChallenge;
  decision: MatchDecision;
  compliance: ComplianceCheckResult;
  reasonCode: string;
  createdAt?: string;
};

export async function createAttestedMatchResult(input: AttestationInput): Promise<AttestedMatchResult> {
  const buyTerms = input.buyTerms;
  const sellTerms = input.sellTerms;
  if (!buyTerms || !sellTerms) {
    throw new Error("createAttestedMatchResult requires decrypted buyTerms and sellTerms");
  }
  const termsHash = hashObject({
    assetId: input.candidate.assetId,
    quantity: Math.min(buyTerms.quantity, sellTerms.quantity),
    buyPrice: buyTerms.price,
    sellPrice: sellTerms.price,
    settlementToken: buyTerms.settlementToken
  });

  const statusMessage =
    input.decision === "MATCH"
      ? "Match found. Review terms."
      : input.decision === "NO_MATCH"
        ? "No match found."
        : input.decision === "PENDING_RETRY"
          ? "Evaluation pending retry."
          : "Compliance review rejected.";

  const unsignedResult = {
    matchId: input.candidate.id,
    proposalBuyId: input.buyProposal.id,
    proposalSellId: input.sellProposal.id,
    decision: input.decision,
    termsHash,
    reasonCode: input.reasonCode,
    compliance: input.compliance,
    maskedSummaryBuyer: createMaskedSummary(input.buyProposal, buyTerms, statusMessage),
    maskedSummarySeller: createMaskedSummary(input.sellProposal, sellTerms, statusMessage),
    createdAt: input.createdAt ?? nowIso()
  } as const;

  const attestationEvidence = await createStubAttestationEvidence({
    config: input.config,
    challenge: input.challenge,
    result: unsignedResult,
    issuedAt: unsignedResult.createdAt
  });

  const attestationHash = hashObject({
    evidence: attestationEvidence,
    decision: input.decision,
    termsHash
  });

  return AttestedMatchResultSchema.parse({
    ...unsignedResult,
    attestationHash,
    attestationEvidence
  });
}
