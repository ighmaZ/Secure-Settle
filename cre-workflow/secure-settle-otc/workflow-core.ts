import type { ConfidentialComputeAdapter } from "./confidential";
import type { ConvergenceAdapter } from "./convergence";
import { verifyAttestationEvidence } from "./attestation-verify";
import { randomHex, sha256Hex, stableJson } from "./crypto-primitives";
import { findCandidatePairs } from "./matcher";
import { createCronTriggerEvent, type TriggerEvent } from "./triggers";
import type {
  AttestedMatchResult,
  ConfidentialChallenge,
  ProposalRecord,
  RuntimeLike,
  WorkflowConfig
} from "./types";

type CycleDependencies = {
  config: WorkflowConfig;
  store: ProposalStoreLike;
  convergence: ConvergenceAdapter;
  confidential: ConfidentialComputeAdapter;
  runtime: RuntimeLike;
  trigger: TriggerEvent;
};

type AttestationVerifierLike = typeof verifyAttestationEvidence;

export type ProposalStoreLike = {
  seedDemoProposalsIfEmpty?: () => Promise<boolean>;
  loadOpenProposals(): Promise<ProposalRecord[]>;
  updateProposalStatus(
    ids: string[],
    status: ProposalRecord["status"],
    note?: string
  ): Promise<void>;
  recordMatchDecision(result: AttestedMatchResult): Promise<void>;
};

export type RunOptions = {
  config: WorkflowConfig;
  store: ProposalStoreLike;
  convergence: ConvergenceAdapter;
  confidential: ConfidentialComputeAdapter;
  attestationVerifier?: AttestationVerifierLike;
  trigger?: TriggerEvent;
  runtime?: RuntimeLike;
};

export type CronCycleResult = {
  processedCandidates: number;
  results: AttestedMatchResult[];
};

const NOOP_RUNTIME: RuntimeLike = {
  log() {
    // Useful for tests and pure execution paths that do not need logs.
  }
};

const MATCHING_NOTE = "Candidate selected for confidential evaluation";

async function buildConfidentialChallenge(
  candidateId: string,
  buyProposal: ProposalRecord,
  sellProposal: ProposalRecord,
  firedAt: string
): Promise<ConfidentialChallenge> {
  const inputHash = await sha256Hex(
    stableJson({
      candidateId,
      firedAt,
      buyProposalId: buyProposal.id,
      buyEncryptedPayloadHash: buyProposal.encryptedPayload.plaintextHash,
      buyEncryptedPayloadRef: buyProposal.encryptedPayloadRef,
      sellProposalId: sellProposal.id,
      sellEncryptedPayloadHash: sellProposal.encryptedPayload.plaintextHash,
      sellEncryptedPayloadRef: sellProposal.encryptedPayloadRef
    })
  );

  return {
    nonce: randomHex(16),
    inputHash,
    issuedAt: firedAt
  };
}

function summarizeResult(result: AttestedMatchResult) {
  return {
    matchId: result.matchId,
    decision: result.decision,
    reasonCode: result.reasonCode,
    attestationHash: result.attestationHash,
    termsHash: result.termsHash
  };
}

function resolveDependencies(options: RunOptions): CycleDependencies {
  return {
    config: options.config,
    store: options.store,
    convergence: options.convergence,
    confidential: options.confidential,
    runtime: options.runtime ?? NOOP_RUNTIME,
    trigger: options.trigger ?? createCronTriggerEvent()
  };
}

async function seedDemoDataIfEnabled({
  config,
  store,
  runtime
}: Pick<CycleDependencies, "config" | "store" | "runtime">): Promise<void> {
  if (!config.demo.seedOnEmpty || !store.seedDemoProposalsIfEmpty) {
    return;
  }

  const didSeed = await store.seedDemoProposalsIfEmpty();
  if (didSeed) {
    runtime.log("Seeded demo proposals into local store");
  }
}

async function evaluateCandidate(
  deps: CycleDependencies,
  proposalsById: Map<string, ProposalRecord>,
  candidateId: {
    id: string;
    proposalBuyId: string;
    proposalSellId: string;
    assetId: string;
  }
): Promise<AttestedMatchResult | null> {
  const { store, runtime, config, convergence, confidential, trigger } = deps;

  const buyProposal = proposalsById.get(candidateId.proposalBuyId);
  const sellProposal = proposalsById.get(candidateId.proposalSellId);
  if (!buyProposal || !sellProposal) {
    runtime.log("Skipping candidate with missing proposal", { candidateId: candidateId.id });
    return null;
  }

  await store.updateProposalStatus(
    [buyProposal.id, sellProposal.id],
    "MATCHING",
    MATCHING_NOTE
  );

  const challenge = await buildConfidentialChallenge(candidateId.id, buyProposal, sellProposal, trigger.firedAt);

  const result = await confidential.evaluateCandidatePair({
    candidate: candidateId,
    buyProposal,
    sellProposal,
    config,
    convergence,
    challenge,
    evaluationTimestamp: trigger.firedAt
  });

  const verification = await verifyAttestationEvidence({
    config,
    result,
    expectedChallenge: challenge
  });
  if (!verification.ok) {
    throw new Error(
      `Attestation verification failed for ${candidateId.id}: ${verification.reasonCode}`
    );
  }

  await store.recordMatchDecision(result);
  runtime.log("Attested evaluation complete", summarizeResult(result));
  return result;
}

export async function runCronCycle(options: RunOptions): Promise<CronCycleResult> {
  const deps = resolveDependencies(options);
  const { store, runtime, config, trigger } = deps;

  await seedDemoDataIfEnabled(deps);

  runtime.log("Trigger fired", {
    type: trigger.type,
    id: trigger.id,
    firedAt: trigger.firedAt
  });

  const openProposals = await store.loadOpenProposals();
  runtime.log("Loaded open proposals", { count: openProposals.length });
  if (openProposals.length === 0) {
    return { processedCandidates: 0, results: [] };
  }

  const candidates = await findCandidatePairs(openProposals, config);
  runtime.log("Candidate scan complete", { candidates: candidates.length });
  if (candidates.length === 0) {
    return { processedCandidates: 0, results: [] };
  }

  const proposalsById = new Map(openProposals.map((proposal) => [proposal.id, proposal] as const));
  const results: AttestedMatchResult[] = [];

  for (const candidate of candidates) {
    const result = await evaluateCandidate(deps, proposalsById, candidate);
    if (result) {
      results.push(result);
    }
  }

  return {
    processedCandidates: candidates.length,
    results
  };
}
