import {
  cre,
  json as readJsonBody,
  ok as isHttpOk,
  Runner,
  text as readTextBody,
  type CronPayload,
  type HTTPPayload,
  type Runtime
} from "@chainlink/cre-sdk";
import { z } from "zod";

const configSchema = z.object({
  workflowId: z.string().min(1),
  schedule: z.string().min(1),
  proposalSourceUrl: z.string().url().nullable(),
  benchmarkUrl: z.string().url().nullable(),
  resultSinkUrl: z.string().url().nullable(),
  owner: z.string().min(1).nullable().default(null),
  secretNamespace: z.string().min(1).nullable().default(null),
  authHeaderSecretKey: z.string().min(1).nullable().default(null),
  encryptResultSinkResponse: z.boolean().default(false),
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

type JsonResponse = {
  statusCode: number;
  body: unknown;
};

type ConfidentialHttpResponse = ReturnType<
  ReturnType<
    InstanceType<typeof cre.capabilities.ConfidentialHTTPClient>["sendRequest"]
  >["result"]
>;

type ConfidentialRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  encryptOutput?: boolean;
};

type WorkflowSummary = {
  totalCandidates: number;
  matches: number;
  rejectedCompliance: number;
  noMatch: number;
  postStatusCode: number;
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

const normalizeWallet = (address: string) => address.toLowerCase();

const isLocalAddress = (url: URL) =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "::1" ||
  url.hostname.endsWith(".local");

const assertSecureRemoteUrl = (rawUrl: string | null, fieldName: string): void => {
  if (!rawUrl) return;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && !isLocalAddress(parsed)) {
    throw new Error(`${fieldName} must use https for non-local endpoints`);
  }
};

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

function buildConfidentialHeaders(config: Config, headers?: Record<string, string>) {
  const multiHeaders: Record<string, { values: string[] }> = {};

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      multiHeaders[key] = { values: [value] };
    }
  }

  if (config.authHeaderSecretKey) {
    multiHeaders.authorization = {
      values: [`Bearer {{.${config.authHeaderSecretKey}}}`]
    };
  }

  return multiHeaders;
}

function buildVaultDonSecrets(config: Config) {
  if (!config.authHeaderSecretKey) {
    return [];
  }

  return [
    {
      key: config.authHeaderSecretKey,
      owner: config.owner ?? undefined,
      namespace: config.secretNamespace ?? undefined
    }
  ];
}

function parseConfidentialResponse(
  response: ConfidentialHttpResponse,
  decryptExpected: boolean
): JsonResponse {
  if (!isHttpOk(response)) {
    throw new Error(`Confidential HTTP request failed with status ${response.statusCode}`);
  }

  if (decryptExpected) {
    return {
      statusCode: response.statusCode,
      body: readTextBody(response)
    };
  }

  try {
    return {
      statusCode: response.statusCode,
      body: readJsonBody(response)
    };
  } catch {
    return {
      statusCode: response.statusCode,
      body: readTextBody(response)
    };
  }
}

function confidentialJsonRequest(
  runtime: Runtime<Config>,
  request: ConfidentialRequest
): JsonResponse {
  const client = new cre.capabilities.ConfidentialHTTPClient();
  const response = client
    .sendRequest(runtime, {
      vaultDonSecrets: buildVaultDonSecrets(runtime.config),
      request: {
        url: request.url,
        method: request.method,
        ...(request.body === undefined ? {} : { bodyString: JSON.stringify(request.body) }),
        multiHeaders: buildConfidentialHeaders(runtime.config, request.headers),
        encryptOutput: request.encryptOutput ?? false
      }
    })
    .result();

  return parseConfidentialResponse(response, request.encryptOutput ?? false);
}

const fetchProposals = (runtime: Runtime<Config>): Proposal[] => {
  if (!runtime.config.proposalSourceUrl) {
    runtime.log(`Using fallback proposals count=${runtime.config.fallbackProposals.length}`);
    return runtime.config.fallbackProposals;
  }

  try {
    const response = confidentialJsonRequest(runtime, {
      url: runtime.config.proposalSourceUrl,
      method: "GET"
    });

    const payload = response.body;
    const rawProposals =
      Array.isArray(payload) ? payload : (payload as { proposals?: unknown[] })?.proposals ?? [];

    return rawProposals.map((item) => proposalSchema.parse(item));
  } catch (error) {
    runtime.log(`Proposal source unavailable, using fallback proposals: ${String(error)}`);
    return runtime.config.fallbackProposals;
  }
};

const fetchBenchmarkPrice = (runtime: Runtime<Config>, assetId: string): number | null => {
  if (!runtime.config.benchmarkUrl) {
    return null;
  }

  try {
    const url = new URL(runtime.config.benchmarkUrl);
    url.searchParams.set("assetId", assetId);

    const response = confidentialJsonRequest(runtime, {
      url: url.toString(),
      method: "GET"
    });

    return benchmarkResponseSchema.parse(response.body).referencePrice;
  } catch (error) {
    runtime.log(`Benchmark fetch failed for assetId=${assetId}: ${String(error)}`);
    return null;
  }
};

const postResults = (runtime: Runtime<Config>, results: MatchResult[]): number => {
  if (!runtime.config.resultSinkUrl || results.length === 0) {
    return 204;
  }

  try {
    const response = confidentialJsonRequest(runtime, {
      url: runtime.config.resultSinkUrl,
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: {
        workflowId: runtime.config.workflowId,
        results
      },
      encryptOutput: runtime.config.encryptResultSinkResponse
    });

    return response.statusCode;
  } catch (error) {
    runtime.log(`Result sink request failed: ${String(error)}`);
    return 503;
  }
};

const evaluateProposals = (
  runtime: Runtime<Config>,
  proposals: Proposal[],
  evaluatedAt: string
): MatchResult[] => {
  const candidates = findCandidates(proposals);
  runtime.log(`Candidate count=${candidates.length}`);

  const results: MatchResult[] = [];
  for (const candidate of candidates) {
    const benchmarkPrice = fetchBenchmarkPrice(runtime, candidate.buy.assetId);
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
  const results = evaluateProposals(runtime, proposals, evaluatedAt);
  const statusCode = postResults(runtime, results);
  runtime.log(`Posted results status=${statusCode}`);
  return results;
};

const summarizeResults = (results: MatchResult[], postStatusCode: number): WorkflowSummary => ({
  totalCandidates: results.length,
  matches: results.filter((result) => result.decision === "MATCH").length,
  rejectedCompliance: results.filter((result) => result.decision === "REJECTED_COMPLIANCE").length,
  noMatch: results.filter((result) => result.decision === "NO_MATCH").length,
  postStatusCode
});

const parseHttpTriggerPayload = (payload: HTTPPayload): Proposal[] => {
  if (!payload.input || payload.input.length === 0) {
    throw new Error("HTTP trigger payload is empty");
  }

  const rawText = new TextDecoder().decode(payload.input);
  const parsed = JSON.parse(rawText) as { proposals?: unknown[] };
  return (parsed.proposals ?? []).map((proposal) => proposalSchema.parse(proposal));
};

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const evaluatedAt = cronPayloadToIsoTime(payload, runtime);
  const proposals = fetchProposals(runtime);

  runtime.log(`Fetched proposals count=${proposals.length}`);

  const results = evaluateProposals(runtime, proposals, evaluatedAt);
  const statusCode = postResults(runtime, results);
  const summary = summarizeResults(results, statusCode);

  runtime.log(`Cycle complete ${JSON.stringify(summary)}`);
  return `Processed ${summary.totalCandidates} candidate(s), ${summary.matches} matched`;
};

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log("HTTP trigger received");
  runtime.log(`Payload size bytes=${payload.input?.length ?? 0}`);
  const proposals = parseHttpTriggerPayload(payload);

  const evaluatedAt = runtime.now().toISOString();
  const results = runMatchingCycle(runtime, proposals, evaluatedAt);

  return JSON.stringify({ evaluatedAt, resultCount: results.length, results });
};

const initWorkflow = (config: Config) => {
  assertSecureRemoteUrl(config.proposalSourceUrl, "proposalSourceUrl");
  assertSecureRemoteUrl(config.benchmarkUrl, "benchmarkUrl");
  assertSecureRemoteUrl(config.resultSinkUrl, "resultSinkUrl");

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
