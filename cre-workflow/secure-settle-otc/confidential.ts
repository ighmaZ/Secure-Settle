import { createAttestedMatchResult } from "./attestation";
import type { ConvergenceAdapter } from "./convergence";
import { decryptProposalPayload } from "./proposal-crypto";
import {
  ComplianceCheckResultSchema,
  ConfidentialComputeHttpRequestSchema,
  ConfidentialComputeHttpResponseSchema,
  type AttestedMatchResult,
  type ComplianceCheckResult,
  type ConfidentialChallenge,
  type MatchCandidate,
  type ProposalPayload,
  type ProposalRecord,
  type WorkflowConfig
} from "./types";

type JsonHttpRequest = {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
};

type JsonHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

export type ConfidentialEvaluateInput = {
  candidate: MatchCandidate;
  buyProposal: ProposalRecord;
  sellProposal: ProposalRecord;
  config: WorkflowConfig;
  convergence: ConvergenceAdapter;
  challenge: ConfidentialChallenge;
  evaluationTimestamp?: string;
};

export type ConfidentialComputeAdapter = {
  evaluateCandidatePair(input: ConfidentialEvaluateInput): Promise<AttestedMatchResult>;
};

export type ConfidentialHttpOptions = {
  endpointUrl: string;
  timeoutMs: number;
  authHeader?: string;
  sendJsonRequest: (request: JsonHttpRequest) => Promise<JsonHttpResponse>;
};

type EvaluationContext = {
  candidate: MatchCandidate;
  buyProposal: ProposalRecord;
  sellProposal: ProposalRecord;
  buyTerms: ProposalPayload;
  sellTerms: ProposalPayload;
  config: WorkflowConfig;
  challenge: ConfidentialChallenge;
  createdAt?: string;
};

async function createResult(
  context: EvaluationContext,
  decision: AttestedMatchResult["decision"],
  reasonCode: string,
  compliance: ComplianceCheckResult
): Promise<AttestedMatchResult> {
  return createAttestedMatchResult({
    config: context.config,
    candidate: context.candidate,
    buyProposal: context.buyProposal,
    sellProposal: context.sellProposal,
    buyTerms: context.buyTerms,
    sellTerms: context.sellTerms,
    challenge: context.challenge,
    decision,
    reasonCode,
    compliance: ComplianceCheckResultSchema.parse(compliance),
    createdAt: context.createdAt
  });
}

function createPassedCompliance(overrides: Partial<ComplianceCheckResult> = {}): ComplianceCheckResult {
  return ComplianceCheckResultSchema.parse({
    passed: true,
    reasonCode: "NONE",
    amlFlag: false,
    sanctionsHit: false,
    positionVerified: true,
    ...overrides
  });
}

function calculatePriceDifferenceBps(buyPrice: number, sellPrice: number): number {
  if (sellPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs((buyPrice - sellPrice) / sellPrice) * 10_000;
}

function optionalConditionsCompatible(
  buyProposal: ProposalPayload,
  sellProposal: ProposalPayload
): boolean {
  const equalityConditionsByField = new Map<string, string>();

  for (const condition of [...buyProposal.optionalConditions, ...sellProposal.optionalConditions]) {
    if (condition.operator !== "==") continue;

    const field = condition.field;
    const serializedValue = JSON.stringify(condition.value);
    const existingValue = equalityConditionsByField.get(field);

    if (existingValue && existingValue !== serializedValue) {
      return false;
    }
    equalityConditionsByField.set(field, serializedValue);
  }

  return true;
}

function isSanctionedWallet(config: WorkflowConfig, address: string): boolean {
  const normalized = address.toLowerCase();
  return config.compliance.sanctionedWallets.some((wallet) => wallet.toLowerCase() === normalized);
}

function buildHttpPayload(input: ConfidentialEvaluateInput) {
  return ConfidentialComputeHttpRequestSchema.parse({
    candidateId: input.candidate.id,
    buyProposal: input.buyProposal,
    sellProposal: input.sellProposal,
    challenge: input.challenge,
    evaluationTimestamp: input.evaluationTimestamp ?? new Date().toISOString(),
    matching: {
      priceToleranceBps: input.config.matching.priceToleranceBps,
      allowPartialFills: input.config.matching.allowPartialFills
    },
    compliance: {
      amlVolumeThreshold: input.config.compliance.amlVolumeThreshold,
      sanctionsSourceMode: input.config.compliance.sanctionsSourceMode
    }
  });
}

function assertMetadataMatchesEncryptedTerms(record: ProposalRecord, terms: ProposalPayload): void {
  if (record.walletAddress.toLowerCase() !== terms.walletAddress.toLowerCase()) {
    throw new Error(`Encrypted payload wallet mismatch for ${record.id}`);
  }
  if (record.side !== terms.side) {
    throw new Error(`Encrypted payload side mismatch for ${record.id}`);
  }
  if (record.assetId !== terms.assetId) {
    throw new Error(`Encrypted payload asset mismatch for ${record.id}`);
  }
  if (record.settlementToken !== terms.settlementToken) {
    throw new Error(`Encrypted payload settlement token mismatch for ${record.id}`);
  }
}

async function loadTermsForStubEvaluation(
  config: WorkflowConfig,
  buyProposal: ProposalRecord,
  sellProposal: ProposalRecord
): Promise<{ buyTerms: ProposalPayload; sellTerms: ProposalPayload }> {
  const buyTerms = await decryptProposalPayload(config, buyProposal.encryptedPayload);
  const sellTerms = await decryptProposalPayload(config, sellProposal.encryptedPayload);

  assertMetadataMatchesEncryptedTerms(buyProposal, buyTerms);
  assertMetadataMatchesEncryptedTerms(sellProposal, sellTerms);

  return { buyTerms, sellTerms };
}

async function evaluateWithStubLogic(input: ConfidentialEvaluateInput): Promise<AttestedMatchResult> {
  const { candidate, buyProposal, sellProposal, config, convergence, challenge, evaluationTimestamp } = input;
  const { buyTerms, sellTerms } = await loadTermsForStubEvaluation(config, buyProposal, sellProposal);

  const context: EvaluationContext = {
    candidate,
    buyProposal,
    sellProposal,
    buyTerms,
    sellTerms,
    config,
    challenge,
    createdAt: evaluationTimestamp
  };

  if (
    isSanctionedWallet(config, buyTerms.walletAddress) ||
    isSanctionedWallet(config, sellTerms.walletAddress)
  ) {
    return createResult(context, "REJECTED_COMPLIANCE", "SANCTIONS_HIT", {
      passed: false,
      reasonCode: "SANCTIONS_HIT",
      amlFlag: false,
      sanctionsHit: true,
      positionVerified: false
    });
  }

  const matchedQuantity = Math.min(buyTerms.quantity, sellTerms.quantity);
  const notional = matchedQuantity * sellTerms.price;
  const amlFlag = notional >= config.compliance.amlVolumeThreshold;

  const sellerPositionCheck = await convergence.verifyPosition(
    sellTerms.walletAddress,
    sellTerms.assetId,
    sellTerms.quantity,
    sellTerms.convergenceBalancesAuth
  );

  if (sellerPositionCheck.reason === "UNAVAILABLE") {
    return createResult(context, "PENDING_RETRY", "CONVERGENCE_UNAVAILABLE", {
      passed: false,
      reasonCode: "CONVERGENCE_UNAVAILABLE",
      amlFlag,
      sanctionsHit: false,
      positionVerified: false
    });
  }

  if (!sellerPositionCheck.ok) {
    return createResult(context, "REJECTED_COMPLIANCE", "INSUFFICIENT_POSITION", {
      passed: false,
      reasonCode: "INSUFFICIENT_POSITION",
      amlFlag,
      sanctionsHit: false,
      positionVerified: false
    });
  }

  const pricesWithinTolerance =
    calculatePriceDifferenceBps(buyTerms.price, sellTerms.price) <= config.matching.priceToleranceBps;
  const quantitiesMatchExactly = buyTerms.quantity === sellTerms.quantity;
  const conditionsMatch = optionalConditionsCompatible(buyTerms, sellTerms);

  if (!quantitiesMatchExactly || !conditionsMatch || !pricesWithinTolerance) {
    const reasonCode = !quantitiesMatchExactly
      ? "QUANTITY_MISMATCH"
      : !conditionsMatch
        ? "OPTIONAL_CONDITIONS_MISMATCH"
        : "PRICE_OUTSIDE_TOLERANCE";

    return createResult(context, "NO_MATCH", reasonCode, createPassedCompliance({ amlFlag }));
  }

  return createResult(
    context,
    "MATCH",
    amlFlag ? "AML_FLAGGED_REVIEW" : "MATCH_CONFIRMED",
    createPassedCompliance({ amlFlag })
  );
}

export function createStubConfidentialComputeAdapter(): ConfidentialComputeAdapter {
  return {
    evaluateCandidatePair: evaluateWithStubLogic
  };
}

export function createHttpConfidentialComputeAdapter(
  options: ConfidentialHttpOptions
): ConfidentialComputeAdapter {
  return {
    async evaluateCandidatePair(input) {
      const payload = buildHttpPayload(input);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.authHeader) {
        headers.authorization = options.authHeader;
      }

      const response = await options.sendJsonRequest({
        url: options.endpointUrl,
        method: "POST",
        headers,
        body: payload,
        timeoutMs: options.timeoutMs
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Confidential compute endpoint failed with status ${response.statusCode}`);
      }

      return ConfidentialComputeHttpResponseSchema.parse(response.body);
    }
  };
}

export function createConfidentialComputeAdapter(
  mode: "stub" | "real" = "stub"
): ConfidentialComputeAdapter {
  if (mode === "real") {
    throw new Error(
      "Real confidential compute adapter requires HTTP endpoint wiring. Use createHttpConfidentialComputeAdapter(...) or stub mode."
    );
  }

  return createStubConfidentialComputeAdapter();
}
