import type { MatchCandidate, ProposalRecord, WorkflowConfig } from "./types";
import { MatchCandidateSchema } from "./types";

function isOpenStatus(status: ProposalRecord["status"]): boolean {
  return status === "SUBMITTED" || status === "QUEUED";
}

function isExpired(proposal: ProposalRecord, now: Date): boolean {
  return new Date(proposal.expiresAt).getTime() <= now.getTime();
}

export async function findCandidatePairs(
  proposals: ProposalRecord[],
  _config: WorkflowConfig,
  now = new Date()
): Promise<MatchCandidate[]> {
  const buys = proposals.filter(
    (p) => p.side === "BUY" && isOpenStatus(p.status) && !isExpired(p, now)
  );
  const sells = proposals.filter(
    (p) => p.side === "SELL" && isOpenStatus(p.status) && !isExpired(p, now)
  );

  const used = new Set<string>();
  const candidates: MatchCandidate[] = [];

  for (const buy of buys) {
    if (used.has(buy.id)) continue;
    const sell = sells.find(
      (s) =>
        !used.has(s.id) &&
        s.assetId === buy.assetId &&
        s.settlementToken === buy.settlementToken &&
        s.walletAddress.toLowerCase() !== buy.walletAddress.toLowerCase()
    );
    if (!sell) continue;

    used.add(buy.id);
    used.add(sell.id);
    candidates.push(
      MatchCandidateSchema.parse({
        id: `match-${buy.id}-${sell.id}`,
        proposalBuyId: buy.id,
        proposalSellId: sell.id,
        assetId: buy.assetId
      })
    );
  }

  return candidates;
}

