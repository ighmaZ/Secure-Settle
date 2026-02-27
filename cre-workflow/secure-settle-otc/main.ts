import {
  consensusIdenticalAggregation,
  cre,
  Runner,
  type CronPayload,
  type HTTPPayload,
  HTTPSendRequester,
  type Runtime
} from "@chainlink/cre-sdk";
import { z } from "zod";

const configSchema = z.object({
  workflowId: z.string().min(1),
  schedule: z.string().min(1),
  proposalSourceUrl: z.string().url().nullable(),
  benchmarkUrl: z.string().url().nullable(),
  resultSinkUrl: z.string().url().nullable(),
  authHeaderSecretName: z.string().min(1).nullable(),
  httpTimeoutMs: z.number().int().positive().default(5000),
  priceToleranceBps: z.number().int().min(0).max(10000),
  requireExactQuantity: z.boolean().default(true),
  amlNotionalThreshold: z.number().positive(),
  sanctionedWallets: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).default([]),
  fallbackProposals: z.array(
    z.object({
      id: z.string().min(1),
      walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      side: z.enum(["BUY", "SELL"]),
      assetId: z.string().min(1),
      quantity: z.number().positive(),
      price: z.number().positive(),
      settlementToken: z.string().min(1),
      optionalConditions: z
        .array(
          z.object({
            field: z.string().min(1),
            operator: z.enum([">", ">=", "<", "<=", "=="]),
            value: z.union([z.string(), z.number(), z.boolean()])
          })
        )
        .default([])
    })
  )
});

type Config = z.infer<typeof configSchema>;
type ConfigInput = z.input<typeof configSchema>;

const proposalSchema = configSchema.shape.fallbackProposals.element;
type Proposal = z.infer<typeof proposalSchema>;

type MatchResult = {
  candidateId: string;
  buyProposalId: string;
  sellProposalId: string;
  decision: "MATCH" | "NO_MATCH" | "REJECTED_COMPLIANCE";
  reasonCode: string;
  matchedQuantity?: number;
  matchedPrice?: number;
  assetId: string;
  settlementToken: string;
  evaluatedAt: string;
};

type PostResponse = {
  statusCode: number;
};

type JsonRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
};

type JsonResponse = {
  statusCode: number;
  body: unknown;
};

const benchmarkResponseSchema = z.object({
  assetId: z.string().min(1),
  referencePrice: z.number().positive(),
  asOf: z.string().datetime()
});
const matchResultSchema: z.ZodType<MatchResult> = z.object({
  candidateId: z.string().min(1),
  buyProposalId: z.string().min(1),
  sellProposalId: z.string().min(1),
  decision: z.enum(["MATCH", "NO_MATCH", "REJECTED_COMPLIANCE"]),
  reasonCode: z.string().min(1),
  matchedQuantity: z.number().positive().optional(),
  matchedPrice: z.number().positive().optional(),
  assetId: z.string().min(1),
  settlementToken: z.string().min(1),
  evaluatedAt: z.string().datetime()
});

const encodeUtf8AsBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  let output = "";
  let index = 0;
  while (index < bytes.length) {
    const byte0 = bytes[index++] ?? 0;
    const byte1 = bytes[index++] ?? 0;
    const byte2 = bytes[index++] ?? 0;

    const triplet = (byte0 << 16) | (byte1 << 8) | byte2;
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += alphabet[(triplet >> 6) & 0x3f];
    output += alphabet[triplet & 0x3f];
  }

  const remainder = bytes.length % 3;
  if (remainder === 1) return `${output.slice(0, -2)}==`;
  if (remainder === 2) return `${output.slice(0, -1)}=`;
  return output;
};

const parseResponseBody = (rawBody: Uint8Array): unknown => {
  const asText = new TextDecoder().decode(rawBody);
  if (!asText) return null;
  try {
    return JSON.parse(asText);
  } catch {
    return asText;
  }
};

const sendJsonRequest = (
  sendRequester: HTTPSendRequester,
  request: JsonRequest
): string => {
  const resp = sendRequester
    .sendRequest({
      url: request.url,
      method: request.method,
      body: request.body === undefined ? "" : encodeUtf8AsBase64(JSON.stringify(request.body)),
      headers: request.headers ?? {},
      timeoutMs: request.timeoutMs
    })
    .result();

  return JSON.stringify({
    statusCode: resp.statusCode,
    body: parseResponseBody(resp.body)
  });
};

const normalizeWallet = (address: string) => address.toLowerCase();

const isSanctioned = (config: Config, walletAddress: string): boolean => {
  const normalized = normalizeWallet(walletAddress);
  return config.sanctionedWallets.some((candidate) => normalizeWallet(candidate) === normalized);
};

const findCandidates = (proposals: Proposal[]): Array<{ buy: Proposal; sell: Proposal }> => {
  const buys = proposals.filter((proposal) => proposal.side === "BUY");
  const sells = proposals.filter((proposal) => proposal.side === "SELL");
  const used = new Set<string>();
  const candidates: Array<{ buy: Proposal; sell: Proposal }> = [];

  for (const buy of buys) {
    if (used.has(buy.id)) continue;

    const sell = sells.find(
      (candidate) =>
        !used.has(candidate.id) &&
        candidate.assetId === buy.assetId &&
        candidate.settlementToken === buy.settlementToken &&
        normalizeWallet(candidate.walletAddress) !== normalizeWallet(buy.walletAddress)
    );

    if (!sell) continue;

    used.add(buy.id);
    used.add(sell.id);
    candidates.push({ buy, sell });
  }

  return candidates;
};

const evaluateCandidate = (
  config: Config,
  buy: Proposal,
  sell: Proposal,
  evaluatedAt: string,
  benchmarkPrice: number | null
): MatchResult => {
  const candidateId = `match-${buy.id}-${sell.id}`;

  if (isSanctioned(config, buy.walletAddress) || isSanctioned(config, sell.walletAddress)) {
    return matchResultSchema.parse({
      candidateId,
      buyProposalId: buy.id,
      sellProposalId: sell.id,
      decision: "REJECTED_COMPLIANCE",
      reasonCode: "SANCTIONS_HIT",
      assetId: buy.assetId,
      settlementToken: buy.settlementToken,
      evaluatedAt
    });
  }

  const matchedQuantity = Math.min(buy.quantity, sell.quantity);
  const notional = matchedQuantity * sell.price;
  if (notional >= config.amlNotionalThreshold) {
    return matchResultSchema.parse({
      candidateId,
      buyProposalId: buy.id,
      sellProposalId: sell.id,
      decision: "REJECTED_COMPLIANCE",
      reasonCode: "AML_THRESHOLD_EXCEEDED",
      assetId: buy.assetId,
      settlementToken: buy.settlementToken,
      evaluatedAt
    });
  }

  const quantityCompatible = config.requireExactQuantity
    ? buy.quantity === sell.quantity
    : matchedQuantity > 0;
  if (!quantityCompatible) {
    return matchResultSchema.parse({
      candidateId,
      buyProposalId: buy.id,
      sellProposalId: sell.id,
      decision: "NO_MATCH",
      reasonCode: "QUANTITY_MISMATCH",
      assetId: buy.assetId,
      settlementToken: buy.settlementToken,
      evaluatedAt
    });
  }

  const priceDifferenceBps = Math.abs((buy.price - sell.price) / sell.price) * 10_000;
  if (priceDifferenceBps > config.priceToleranceBps) {
    return matchResultSchema.parse({
      candidateId,
      buyProposalId: buy.id,
      sellProposalId: sell.id,
      decision: "NO_MATCH",
      reasonCode: "PRICE_OUTSIDE_TOLERANCE",
      assetId: buy.assetId,
      settlementToken: buy.settlementToken,
      evaluatedAt
    });
  }

  if (benchmarkPrice !== null) {
    const distanceFromBenchmarkBps = Math.abs((sell.price - benchmarkPrice) / benchmarkPrice) * 10_000;
    if (distanceFromBenchmarkBps > 1000) {
      return matchResultSchema.parse({
        candidateId,
        buyProposalId: buy.id,
        sellProposalId: sell.id,
        decision: "NO_MATCH",
        reasonCode: "BENCHMARK_DEVIATION_TOO_HIGH",
        assetId: buy.assetId,
        settlementToken: buy.settlementToken,
        evaluatedAt
      });
    }
  }

  return matchResultSchema.parse({
    candidateId,
    buyProposalId: buy.id,
    sellProposalId: sell.id,
    decision: "MATCH",
    reasonCode: "MATCH_CONFIRMED",
    matchedQuantity,
    matchedPrice: sell.price,
    assetId: buy.assetId,
    settlementToken: buy.settlementToken,
    evaluatedAt
  });
};

const getAuthHeader = (runtime: Runtime<Config>): string | undefined => {
  if (!runtime.config.authHeaderSecretName) return undefined;

  const secret = runtime.getSecret({ id: runtime.config.authHeaderSecretName }).result();
  if (!secret.value) {
    throw new Error(`Secret '${runtime.config.authHeaderSecretName}' is empty`);
  }

  return secret.value;
};

const fetchProposals = (
  runtime: Runtime<Config>,
  authHeader: string | undefined
): Proposal[] => {
  if (!runtime.config.proposalSourceUrl) {
    runtime.log(`Using fallback proposals count=${runtime.config.fallbackProposals.length}`);
    return runtime.config.fallbackProposals;
  }

  const httpClient = new cre.capabilities.HTTPClient();
  const response = httpClient
    .sendRequest(runtime, sendJsonRequest, consensusIdenticalAggregation<string>())({
      url: runtime.config.proposalSourceUrl,
      method: "GET",
      headers: authHeader ? { authorization: authHeader } : undefined,
      timeoutMs: runtime.config.httpTimeoutMs
    })
    .result();
  const parsedResponse = JSON.parse(response) as JsonResponse;

  if (parsedResponse.statusCode < 200 || parsedResponse.statusCode >= 300) {
    throw new Error(`Proposal source request failed with status ${parsedResponse.statusCode}`);
  }

  const payload = parsedResponse.body;
  const rawProposals =
    Array.isArray(payload) ? payload : (payload as { proposals?: unknown[] })?.proposals ?? [];

  return rawProposals.map((item) => proposalSchema.parse(item));
};

const fetchBenchmarkPrice = (
  runtime: Runtime<Config>,
  authHeader: string | undefined,
  assetId: string
): number | null => {
  if (!runtime.config.benchmarkUrl) {
    return null;
  }

  const url = new URL(runtime.config.benchmarkUrl);
  url.searchParams.set("assetId", assetId);

  const httpClient = new cre.capabilities.HTTPClient();
  const response = httpClient
    .sendRequest(runtime, sendJsonRequest, consensusIdenticalAggregation<string>())({
      url: url.toString(),
      method: "GET",
      headers: authHeader ? { authorization: authHeader } : undefined,
      timeoutMs: runtime.config.httpTimeoutMs
    })
    .result();
  const parsedResponse = JSON.parse(response) as JsonResponse;

  if (parsedResponse.statusCode < 200 || parsedResponse.statusCode >= 300) {
    return null;
  }

  return benchmarkResponseSchema.parse(parsedResponse.body).referencePrice;
};

const postResults = (
  runtime: Runtime<Config>,
  authHeader: string | undefined,
  results: MatchResult[]
): PostResponse => {
  if (!runtime.config.resultSinkUrl || results.length === 0) {
    return { statusCode: 204 };
  }

  const httpClient = new cre.capabilities.HTTPClient();
  const response = httpClient
    .sendRequest(runtime, sendJsonRequest, consensusIdenticalAggregation<string>())({
      url: runtime.config.resultSinkUrl,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {})
      },
      body: {
        workflowId: runtime.config.workflowId,
        results
      },
      timeoutMs: runtime.config.httpTimeoutMs
    })
    .result();
  const parsedResponse = JSON.parse(response) as JsonResponse;
  return { statusCode: parsedResponse.statusCode };
};

const evaluateProposals = (
  runtime: Runtime<Config>,
  proposals: Proposal[],
  evaluatedAt: string,
  authHeader: string | undefined
): MatchResult[] => {
  const candidates = findCandidates(proposals);
  runtime.log(`Candidate count=${candidates.length}`);

  const results: MatchResult[] = [];
  for (const candidate of candidates) {
    const benchmarkPrice = fetchBenchmarkPrice(runtime, authHeader, candidate.buy.assetId);
    const result = evaluateCandidate(
      runtime.config,
      candidate.buy,
      candidate.sell,
      evaluatedAt,
      benchmarkPrice
    );
    results.push(result);
  }

  return results;
};

const cronPayloadToIsoTime = (payload: CronPayload, runtime: Runtime<Config>): string => {
  const scheduled = payload.scheduledExecutionTime;
  if (scheduled?.seconds !== undefined) {
    const ms = Number(scheduled.seconds) * 1000 + Math.floor((scheduled.nanos ?? 0) / 1_000_000);
    return new Date(ms).toISOString();
  }

  return runtime.now().toISOString();
};

const runMatchingCycle = (
  runtime: Runtime<Config>,
  proposals: Proposal[],
  evaluatedAt: string
): MatchResult[] => {
  const authHeader = getAuthHeader(runtime);
  const results = evaluateProposals(runtime, proposals, evaluatedAt, authHeader);
  const postResult = postResults(runtime, authHeader, results);

  runtime.log(`Posted results status=${postResult.statusCode}`);
  return results;
};

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const evaluatedAt = cronPayloadToIsoTime(payload, runtime);
  const authHeader = getAuthHeader(runtime);
  const proposals = fetchProposals(runtime, authHeader);

  runtime.log(`Fetched proposals count=${proposals.length}`);

  const results = evaluateProposals(runtime, proposals, evaluatedAt, authHeader);
  const postResult = postResults(runtime, authHeader, results);

  const summary = {
    totalCandidates: results.length,
    matches: results.filter((result) => result.decision === "MATCH").length,
    rejectedCompliance: results.filter((result) => result.decision === "REJECTED_COMPLIANCE").length,
    noMatch: results.filter((result) => result.decision === "NO_MATCH").length,
    postStatusCode: postResult.statusCode
  };

  runtime.log(`Cycle complete ${JSON.stringify(summary)}`);
  return `Processed ${summary.totalCandidates} candidate(s), ${summary.matches} matched`;
};

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log("Raw HTTP trigger received");

  if (!payload.input || payload.input.length === 0) {
    throw new Error("HTTP trigger payload is empty");
  }

  const rawText = new TextDecoder().decode(payload.input);
  runtime.log(`Payload bytes payloadBytes ${rawText}`);

  const parsed = JSON.parse(rawText) as { proposals?: unknown[] };
  const proposals = (parsed.proposals ?? []).map((proposal) => proposalSchema.parse(proposal));

  const evaluatedAt = runtime.now().toISOString();
  const results = runMatchingCycle(runtime, proposals, evaluatedAt);

  return JSON.stringify({ evaluatedAt, resultCount: results.length, results });
};

const initWorkflow = (config: Config) => {
  const cronCapability = new cre.capabilities.CronCapability();
  const httpTrigger = new cre.capabilities.HTTPCapability();

  return [
    cre.handler(cronCapability.trigger({ schedule: config.schedule }), onCronTrigger),
    cre.handler(httpTrigger.trigger({}), onHTTPTrigger)
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config, ConfigInput>({
    configSchema
  });
  await runner.run(initWorkflow);
}

main();
