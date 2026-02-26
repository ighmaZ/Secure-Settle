import { DEMO_PROPOSALS } from "./fixtures";
import { encryptProposalPayload } from "./proposal-crypto";
import {
  LocalStoreSchema,
  ProposalPayloadSchema,
  ProposalRecordSchema,
  WorkflowStatusViewSchema,
  type AttestedMatchResult,
  type LocalStore,
  type ProposalPayload,
  type ProposalRecord,
  type WorkflowConfig,
  type WorkflowStatusView
} from "./types";

type Clock = () => Date;

const OPEN_PROPOSAL_STATUSES: ProposalRecord["status"][] = [
  "SUBMITTED",
  "QUEUED",
  "MATCHING",
  "PENDING_RETRY"
];

type MemoryStateContext = {
  config: WorkflowConfig;
  now: Clock;
};

export type MemoryStoreAdapter = {
  loadOpenProposals(): Promise<ProposalRecord[]>;
  submitProposal(payload: ProposalPayload): Promise<ProposalRecord>;
  updateProposalStatus(ids: string[], status: ProposalRecord["status"], note?: string): Promise<void>;
  recordMatchDecision(result: AttestedMatchResult): Promise<void>;
  seedDemoProposalsIfEmpty(): Promise<boolean>;
  getWorkflowStatus(id: string): Promise<WorkflowStatusView | null>;
  getState(): Promise<LocalStore>;
  resetState(): Promise<void>;
};

function createEmptyState(): LocalStore {
  return LocalStoreSchema.parse({
    proposals: [],
    matches: [],
    workflowEvents: []
  });
}

function addWorkflowEvent(state: LocalStore, now: Clock, type: string, message: string): void {
  state.workflowEvents.push({
    id: `evt-${state.workflowEvents.length + 1}`,
    type,
    message,
    createdAt: now().toISOString(),
    redacted: true
  });
}

function nextProposalNumber(state: LocalStore): number {
  const maxProposalNumber = state.proposals.reduce((max, proposal) => {
    const match = /^proposal-(\d+)$/.exec(proposal.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return maxProposalNumber + 1;
}

async function createProposalRecord(
  payload: ProposalPayload,
  proposalNumber: number,
  { config, now }: MemoryStateContext
): Promise<ProposalRecord> {
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + config.matching.proposalExpiryMinutes * 60_000);
  const proposalId = `proposal-${proposalNumber}`;
  const encryptedPayload = await encryptProposalPayload(config, proposalId, payload);

  return ProposalRecordSchema.parse({
    walletAddress: payload.walletAddress,
    role: payload.role,
    side: payload.side,
    assetId: payload.assetId,
    settlementToken: payload.settlementToken,
    id: proposalId,
    status: "SUBMITTED",
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    encryptedPayloadRef:
      payload.encryptedPayloadRef ??
      `enc://proposal/${proposalNumber}-${createdAt.getTime().toString(36)}`,
    encryptedPayload,
    evaluationNotes: []
  });
}

function proposalStatusForDecision(
  decision: AttestedMatchResult["decision"]
): ProposalRecord["status"] {
  switch (decision) {
    case "MATCH":
      return "MATCH_PENDING_CONFIRMATION";
    case "NO_MATCH":
      return "NO_MATCH";
    case "REJECTED_COMPLIANCE":
      return "REJECTED_COMPLIANCE";
    case "PENDING_RETRY":
      return "PENDING_RETRY";
  }
}

function appendEvaluationNote(
  proposal: ProposalRecord,
  result: AttestedMatchResult
): ProposalRecord["evaluationNotes"] {
  return [
    ...proposal.evaluationNotes,
    `decision=${result.decision} reason=${result.reasonCode} attestation=${result.attestationHash.slice(0, 12)}...`
  ];
}

function nextActionForProposalStatus(status: ProposalRecord["status"]): string {
  switch (status) {
    case "MATCH_PENDING_CONFIRMATION":
      return "Review and confirm match";
    case "PENDING_RETRY":
      return "Retry evaluation";
    default:
      return "Wait";
  }
}

function buildWorkflowStatus(state: LocalStore, id: string): WorkflowStatusView | null {
  const proposal = state.proposals.find((item) => item.id === id);
  if (proposal) {
    return WorkflowStatusViewSchema.parse({
      entityType: "proposal",
      id,
      status: proposal.status,
      nextAction: nextActionForProposalStatus(proposal.status),
      updatedAt: proposal.updatedAt
    });
  }

  const match = state.matches.find((item) => item.matchId === id);
  if (!match) return null;

  return WorkflowStatusViewSchema.parse({
    entityType: "match",
    id,
    status: match.decision,
    nextAction: match.decision === "MATCH" ? "Await confirmations" : "None",
    maskedSummary: match.maskedSummaryBuyer,
    errorCode: match.decision === "MATCH" ? undefined : match.reasonCode,
    updatedAt: match.createdAt
  });
}

function findProposalById(state: LocalStore, id: string): ProposalRecord | undefined {
  return state.proposals.find((proposal) => proposal.id === id);
}

export function createInMemoryStore(
  config: WorkflowConfig,
  now: Clock = () => new Date()
): MemoryStoreAdapter {
  const context: MemoryStateContext = { config, now };
  let state = createEmptyState();

  return {
    async loadOpenProposals() {
      return state.proposals.filter((proposal) => OPEN_PROPOSAL_STATUSES.includes(proposal.status));
    },

    async submitProposal(payload) {
      const proposal = await createProposalRecord(payload, nextProposalNumber(state), context);
      state.proposals.push(proposal);
      addWorkflowEvent(state, now, "proposal.submitted", `Submitted proposal ${proposal.id}`);
      return proposal;
    },

    async updateProposalStatus(ids, status, note) {
      const updatedAt = now().toISOString();

      for (const id of ids) {
        const proposal = findProposalById(state, id);
        if (!proposal) continue;
        proposal.status = status;
        proposal.updatedAt = updatedAt;
        if (note) {
          proposal.evaluationNotes = [...proposal.evaluationNotes, note];
        }
      }

      addWorkflowEvent(state, now, "proposal.status", `Updated ${ids.length} proposal(s) to ${status}`);
    },

    async recordMatchDecision(result) {
      const existingMatchIndex = state.matches.findIndex((match) => match.matchId === result.matchId);
      if (existingMatchIndex >= 0) {
        state.matches[existingMatchIndex] = result;
      } else {
        state.matches.push(result);
      }

      const nextStatus = proposalStatusForDecision(result.decision);
      const updatedAt = now().toISOString();

      for (const proposalId of [result.proposalBuyId, result.proposalSellId]) {
        const proposal = findProposalById(state, proposalId);
        if (!proposal) continue;
        proposal.status = nextStatus;
        proposal.updatedAt = updatedAt;
        proposal.evaluationNotes = appendEvaluationNote(proposal, result);
      }

      addWorkflowEvent(state, now, "match.recorded", `Recorded ${result.decision} for ${result.matchId}`);
    },

    async seedDemoProposalsIfEmpty() {
      if (state.proposals.length > 0) return false;

      for (const payload of DEMO_PROPOSALS) {
        const proposal = await createProposalRecord(payload, nextProposalNumber(state), context);
        state.proposals.push(proposal);
      }

      addWorkflowEvent(state, now, "seed", `Seeded ${state.proposals.length} demo proposals`);
      return true;
    },

    async getWorkflowStatus(id) {
      return buildWorkflowStatus(state, id);
    },

    async getState() {
      return LocalStoreSchema.parse(state);
    },

    async resetState() {
      state = createEmptyState();
      addWorkflowEvent(state, now, "reset", "In-memory state reset");
    }
  };
}
