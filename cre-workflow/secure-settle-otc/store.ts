import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEMO_PROPOSALS } from "./fixtures";
import { encryptProposalPayload } from "./proposal-crypto";
import {
  LocalStoreSchema,
  ProposalPayloadSchema,
  ProposalRecordSchema,
  WorkflowStatusViewSchema,
  nowIso,
  type AttestedMatchResult,
  type LocalStore,
  type ProposalPayload,
  type ProposalRecord,
  type WorkflowConfig,
  type WorkflowStatusView
} from "./types";

const OPEN_PROPOSAL_STATUSES: ProposalRecord["status"][] = [
  "SUBMITTED",
  "QUEUED",
  "MATCHING",
  "PENDING_RETRY"
];

export type StoreAdapter = {
  loadOpenProposals(): Promise<ProposalRecord[]>;
  upsertProposal(proposal: ProposalRecord): Promise<void>;
  submitProposal(payload: ProposalPayload): Promise<ProposalRecord>;
  updateProposalStatus(ids: string[], status: ProposalRecord["status"], note?: string): Promise<void>;
  recordMatchDecision(result: AttestedMatchResult): Promise<void>;
  getWorkflowStatus(id: string): Promise<WorkflowStatusView | null>;
  seedDemoProposalsIfEmpty(): Promise<boolean>;
  getState(): Promise<LocalStore>;
  resetState(): Promise<void>;
};

type FileStoreContext = {
  config: WorkflowConfig;
  dataPath: string;
};

function createEmptyState(): LocalStore {
  return LocalStoreSchema.parse({
    proposals: [],
    matches: [],
    workflowEvents: []
  });
}

function addWorkflowEvent(state: LocalStore, type: string, message: string): void {
  state.workflowEvents.push({
    id: `evt-${state.workflowEvents.length + 1}`,
    type,
    message,
    createdAt: nowIso(),
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
  config: WorkflowConfig
): Promise<ProposalRecord> {
  const createdAt = new Date();
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

function buildWorkflowStatusView(state: LocalStore, id: string): WorkflowStatusView | null {
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

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function readStateOrNull(dataPath: string): Promise<LocalStore | null> {
  try {
    const raw = await readFile(dataPath, "utf8");
    return LocalStoreSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readStateOrEmpty(dataPath: string): Promise<LocalStore> {
  return (await readStateOrNull(dataPath)) ?? createEmptyState();
}

async function writeState(dataPath: string, state: LocalStore): Promise<void> {
  await ensureParentDirectory(dataPath);
  const normalized = LocalStoreSchema.parse(state);
  await writeFile(dataPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function withEvent(state: LocalStore, type: string, message: string): LocalStore {
  addWorkflowEvent(state, type, message);
  return state;
}

export function resolveDataPath(config: WorkflowConfig): string {
  return path.resolve(import.meta.dirname, config.storage.dataPath);
}

export function createLocalFileStore(config: WorkflowConfig): StoreAdapter {
  const ctx: FileStoreContext = {
    config,
    dataPath: resolveDataPath(config)
  };

  return {
    async getState() {
      return readStateOrEmpty(ctx.dataPath);
    },

    async seedDemoProposalsIfEmpty() {
      const state = await readStateOrEmpty(ctx.dataPath);
      if (state.proposals.length > 0) return false;

      const seededProposals: ProposalRecord[] = [];
      for (const payload of DEMO_PROPOSALS) {
        const proposal = await createProposalRecord(payload, nextProposalNumber(state), ctx.config);
        state.proposals.push(proposal);
        seededProposals.push(proposal);
      }
      withEvent(state, "seed", `Seeded ${seededProposals.length} demo proposals`);
      await writeState(ctx.dataPath, state);
      return true;
    },

    async loadOpenProposals() {
      const state = await readStateOrEmpty(ctx.dataPath);
      return state.proposals.filter((proposal) => OPEN_PROPOSAL_STATUSES.includes(proposal.status));
    },

    async submitProposal(payload) {
      const state = await readStateOrEmpty(ctx.dataPath);
      const proposal = await createProposalRecord(payload, nextProposalNumber(state), ctx.config);
      state.proposals.push(proposal);
      withEvent(state, "proposal.submitted", `Submitted proposal ${proposal.id}`);
      await writeState(ctx.dataPath, state);
      return proposal;
    },

    async upsertProposal(proposal) {
      const state = await readStateOrEmpty(ctx.dataPath);
      const normalizedProposal = ProposalRecordSchema.parse(proposal);
      const existingIndex = state.proposals.findIndex((item) => item.id === normalizedProposal.id);

      if (existingIndex >= 0) {
        state.proposals[existingIndex] = normalizedProposal;
      } else {
        state.proposals.push(normalizedProposal);
      }

      withEvent(state, "proposal.upsert", `Upserted proposal ${normalizedProposal.id}`);
      await writeState(ctx.dataPath, state);
    },

    async updateProposalStatus(ids, status, note) {
      const state = await readStateOrEmpty(ctx.dataPath);
      const updatedAt = nowIso();

      for (const id of ids) {
        const proposal = findProposalById(state, id);
        if (!proposal) continue;
        proposal.status = status;
        proposal.updatedAt = updatedAt;
        if (note) {
          proposal.evaluationNotes = [...proposal.evaluationNotes, note];
        }
      }

      withEvent(state, "proposal.status", `Updated ${ids.length} proposal(s) to ${status}`);
      await writeState(ctx.dataPath, state);
    },

    async recordMatchDecision(result) {
      const state = await readStateOrEmpty(ctx.dataPath);
      const existingMatchIndex = state.matches.findIndex((match) => match.matchId === result.matchId);

      if (existingMatchIndex >= 0) {
        state.matches[existingMatchIndex] = result;
      } else {
        state.matches.push(result);
      }

      const nextStatus = proposalStatusForDecision(result.decision);
      const updatedAt = nowIso();

      for (const proposalId of [result.proposalBuyId, result.proposalSellId]) {
        const proposal = findProposalById(state, proposalId);
        if (!proposal) continue;
        proposal.status = nextStatus;
        proposal.updatedAt = updatedAt;
        proposal.evaluationNotes = appendEvaluationNote(proposal, result);
      }

      withEvent(state, "match.recorded", `Recorded ${result.decision} for ${result.matchId}`);
      await writeState(ctx.dataPath, state);
    },

    async getWorkflowStatus(id) {
      const state = await readStateOrEmpty(ctx.dataPath);
      return buildWorkflowStatusView(state, id);
    },

    async resetState() {
      const state = createEmptyState();
      withEvent(state, "reset", "Local state reset");
      await writeState(ctx.dataPath, state);
    }
  };
}
