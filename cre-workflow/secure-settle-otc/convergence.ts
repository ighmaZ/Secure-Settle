import { DEMO_ASSETS, DEMO_POSITIONS } from "./fixtures";
import {
  ConvergenceAssetSchema,
  ConvergenceBalancesRequestSchema,
  ConvergenceBalancesResponseSchema,
  ConvergenceErrorResponseSchema,
  ConvergencePrivateTransferRequestSchema,
  ConvergencePrivateTransferResponseSchema,
  ConvergenceShieldedAddressRequestSchema,
  ConvergenceShieldedAddressResponseSchema,
  ConvergenceTransactionsRequestSchema,
  ConvergenceTransactionsResponseSchema,
  ConvergenceWithdrawRequestSchema,
  ConvergenceWithdrawResponseSchema,
  PortfolioPositionSchema,
  PositionCheckResultSchema,
  type ConvergenceAsset,
  type ConvergenceBalancesRequest,
  type ConvergenceBalancesResponse,
  type ConvergencePrivateTransferRequest,
  type ConvergencePrivateTransferResponse,
  type ConvergenceShieldedAddressRequest,
  type ConvergenceShieldedAddressResponse,
  type ConvergenceTransactionsRequest,
  type ConvergenceTransactionsResponse,
  type ConvergenceWithdrawRequest,
  type ConvergenceWithdrawResponse,
  type PortfolioPosition,
  type PositionCheckResult,
  type WorkflowConfig
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_STUB_SHIELDED_ADDRESS = "0xBBb514910646061C15fA564482E8d2682Fa8dC5A";
const ONE_HOUR_SECONDS = 3600;
const DEMO_TOKEN_DECIMALS = 18n;

type SignedPostRequest<TBody> = {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
  body: TBody;
  timeoutMs?: number;
};

export type JsonHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

export type ConvergenceAdapter = {
  // Convergence hackathon API endpoints (EIP-712 signed POST payloads)
  getBalances(request: ConvergenceBalancesRequest): Promise<ConvergenceBalancesResponse>;
  listTransactions(request: ConvergenceTransactionsRequest): Promise<ConvergenceTransactionsResponse>;
  privateTransfer(
    request: ConvergencePrivateTransferRequest
  ): Promise<ConvergencePrivateTransferResponse>;
  requestWithdraw(request: ConvergenceWithdrawRequest): Promise<ConvergenceWithdrawResponse>;
  generateShieldedAddress(
    request: ConvergenceShieldedAddressRequest
  ): Promise<ConvergenceShieldedAddressResponse>;

  // SecureSettle compatibility helpers
  getPortfolio(walletAddress: string): Promise<PortfolioPosition[]>;
  getAsset(assetId: string): Promise<ConvergenceAsset | null>;
  verifyPosition(
    walletAddress: string,
    assetId: string,
    minQty: number,
    authContext?: ConvergenceBalancesRequest
  ): Promise<PositionCheckResult>;
};

export type ConvergenceOptions = {
  mode?: "stub" | "live";
  simulateUnavailableWallets?: string[];
  fetchImpl?: typeof fetch;
  sendJsonRequest?: (request: SignedPostRequest<unknown>) => Promise<JsonHttpResponse>;
};

type AdapterContext = {
  config: WorkflowConfig;
  mode: "stub" | "live";
  fetchImpl: typeof fetch;
  sendJsonRequest?: (request: SignedPostRequest<unknown>) => Promise<JsonHttpResponse>;
  unavailableWallets: Set<string>;
  assetsById: Map<string, ConvergenceAsset>;
};

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function isUnavailableWallet(ctx: AdapterContext, address: string): boolean {
  return ctx.unavailableWallets.has(normalizeAddress(address));
}

function quantityToOnchainAmount(quantity: number): string {
  return (BigInt(Math.trunc(quantity)) * 10n ** DEMO_TOKEN_DECIMALS).toString();
}

function onchainAmountToQuantity(amount: string): number {
  try {
    return Number(BigInt(amount) / 10n ** DEMO_TOKEN_DECIMALS);
  } catch {
    return 0;
  }
}

function createStubId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSuccessfulJsonResponse<T>(
  response: Response,
  schema: { parse: (value: unknown) => T }
): Promise<T> {
  return response.json().then((json) => {
    if (!response.ok) {
      const parsedError = ConvergenceErrorResponseSchema.safeParse(json);
      if (parsedError.success) {
        throw new Error(
          `Convergence API error ${parsedError.data.error}: ${parsedError.data.error_details}`
        );
      }
      throw new Error(`Convergence API request failed with status ${response.status}`);
    }
    return schema.parse(json);
  });
}

function parseCapabilityJsonResponse<T>(
  response: JsonHttpResponse,
  schema: { parse: (value: unknown) => T }
): T {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const parsedError = ConvergenceErrorResponseSchema.safeParse(response.body);
    if (parsedError.success) {
      throw new Error(
        `Convergence API error ${parsedError.data.error}: ${parsedError.data.error_details}`
      );
    }
    throw new Error(`Convergence API request failed with status ${response.statusCode}`);
  }

  return schema.parse(response.body);
}

async function postSignedJson<TReq, TRes>(
  ctx: AdapterContext,
  endpointPath: string,
  request: TReq,
  requestSchema: { parse: (value: unknown) => TReq },
  responseSchema: { parse: (value: unknown) => TRes }
): Promise<TRes> {
  if (ctx.mode !== "live") {
    throw new Error("postSignedJson is only available in live mode");
  }

  requestSchema.parse(request);
  const url = new URL(endpointPath, ctx.config.convergence.baseUrl).toString();
  const headers = { "content-type": "application/json" };

  if (ctx.sendJsonRequest) {
    const capabilityResponse = await ctx.sendJsonRequest({
      url,
      method: "POST",
      headers,
      body: request,
      timeoutMs: ctx.config.convergence.timeoutMs
    });
    return parseCapabilityJsonResponse(capabilityResponse, responseSchema);
  }

  const response = await ctx.fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request)
  });
  return parseSuccessfulJsonResponse(response, responseSchema);
}

function buildStubTransactions(account: string): ConvergenceTransactionsResponse {
  const normalizedAccount = normalizeAddress(account);
  const position = DEMO_POSITIONS.find(
    (candidate) => normalizeAddress(candidate.walletAddress) === normalizedAccount
  );

  if (!position) {
    return ConvergenceTransactionsResponseSchema.parse({
      transactions: [],
      has_more: false
    });
  }

  return ConvergenceTransactionsResponseSchema.parse({
    transactions: [
      {
        id: "01950000-0000-7000-0000-000000000001",
        type: "deposit",
        account: position.walletAddress,
        token: position.tokenAddress ?? ZERO_ADDRESS,
        amount: quantityToOnchainAmount(position.quantity),
        tx_hash: "0x1234"
      }
    ],
    has_more: false
  });
}

function buildUnavailablePositionCheck(): PositionCheckResult {
  return PositionCheckResultSchema.parse({
    ok: false,
    reason: "UNAVAILABLE",
    availableQuantity: 0
  });
}

function buildNotFoundPositionCheck(): PositionCheckResult {
  return PositionCheckResultSchema.parse({
    ok: false,
    reason: "NOT_FOUND",
    availableQuantity: 0
  });
}

function buildPositionCheck(availableQuantity: number, minQty: number): PositionCheckResult {
  return PositionCheckResultSchema.parse({
    ok: availableQuantity >= minQty,
    reason: availableQuantity >= minQty ? "OK" : "INSUFFICIENT_POSITION",
    availableQuantity
  });
}

async function getLiveBalancesOrThrow(
  adapter: ConvergenceAdapter,
  walletAddress: string,
  authContext: ConvergenceBalancesRequest | undefined
): Promise<ConvergenceBalancesResponse> {
  if (!authContext) {
    throw new Error("Missing signed /balances auth context");
  }

  if (normalizeAddress(authContext.account) !== normalizeAddress(walletAddress)) {
    throw new Error("Signed /balances auth context account does not match seller wallet");
  }

  return adapter.getBalances(authContext);
}

function buildContext(config: WorkflowConfig, options: ConvergenceOptions): AdapterContext {
  return {
    config,
    mode: options.mode ?? "stub",
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    sendJsonRequest: options.sendJsonRequest,
    unavailableWallets: new Set(
      (options.simulateUnavailableWallets ?? []).map((wallet) => normalizeAddress(wallet))
    ),
    assetsById: new Map(
      DEMO_ASSETS.map((asset) => [asset.assetId, ConvergenceAssetSchema.parse(asset)])
    )
  };
}

export function createConvergenceAdapter(
  config: WorkflowConfig,
  options: ConvergenceOptions = {}
): ConvergenceAdapter {
  const ctx = buildContext(config, options);

  const adapter: ConvergenceAdapter = {
    async getBalances(request) {
      const parsed = ConvergenceBalancesRequestSchema.parse(request);
      if (isUnavailableWallet(ctx, parsed.account)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        return postSignedJson(
          ctx,
          "/balances",
          parsed,
          ConvergenceBalancesRequestSchema,
          ConvergenceBalancesResponseSchema
        );
      }

      const balances = DEMO_POSITIONS.filter(
        (position) => normalizeAddress(position.walletAddress) === normalizeAddress(parsed.account)
      ).map((position) => ({
        token: position.tokenAddress ?? ZERO_ADDRESS,
        amount: quantityToOnchainAmount(position.quantity)
      }));

      return ConvergenceBalancesResponseSchema.parse({ balances });
    },

    async listTransactions(request) {
      const parsed = ConvergenceTransactionsRequestSchema.parse(request);
      if (isUnavailableWallet(ctx, parsed.account)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        return postSignedJson(
          ctx,
          "/transactions",
          parsed,
          ConvergenceTransactionsRequestSchema,
          ConvergenceTransactionsResponseSchema
        );
      }

      return buildStubTransactions(parsed.account);
    },

    async privateTransfer(request) {
      const parsed = ConvergencePrivateTransferRequestSchema.parse(request);
      if (isUnavailableWallet(ctx, parsed.account)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        return postSignedJson(
          ctx,
          "/private-transfer",
          parsed,
          ConvergencePrivateTransferRequestSchema,
          ConvergencePrivateTransferResponseSchema
        );
      }

      return ConvergencePrivateTransferResponseSchema.parse({
        transaction_id: createStubId("tx")
      });
    },

    async requestWithdraw(request) {
      const parsed = ConvergenceWithdrawRequestSchema.parse(request);
      if (isUnavailableWallet(ctx, parsed.account)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        return postSignedJson(
          ctx,
          "/withdraw",
          parsed,
          ConvergenceWithdrawRequestSchema,
          ConvergenceWithdrawResponseSchema
        );
      }

      return ConvergenceWithdrawResponseSchema.parse({
        id: createStubId("wd"),
        account: parsed.account,
        token: parsed.token,
        amount: parsed.amount,
        deadline: Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS,
        ticket: "0xdeadbeef"
      });
    },

    async generateShieldedAddress(request) {
      const parsed = ConvergenceShieldedAddressRequestSchema.parse(request);
      if (isUnavailableWallet(ctx, parsed.account)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        return postSignedJson(
          ctx,
          "/shielded-address",
          parsed,
          ConvergenceShieldedAddressRequestSchema,
          ConvergenceShieldedAddressResponseSchema
        );
      }

      return ConvergenceShieldedAddressResponseSchema.parse({
        address: DEFAULT_STUB_SHIELDED_ADDRESS
      });
    },

    async getPortfolio(walletAddress) {
      if (isUnavailableWallet(ctx, walletAddress)) {
        throw new Error("Convergence API unavailable (simulated)");
      }

      if (ctx.mode === "live") {
        // Convergence exposes balances/transactions rather than a portfolio endpoint.
        // The app can build a portfolio view by combining /balances with local token metadata.
        return [];
      }

      return DEMO_POSITIONS.filter(
        (position) => normalizeAddress(position.walletAddress) === normalizeAddress(walletAddress)
      ).map((position) => PortfolioPositionSchema.parse(position));
    },

    async getAsset(assetId) {
      return ctx.assetsById.get(assetId) ?? null;
    },

    async verifyPosition(walletAddress, assetId, minQty, authContext) {
      if (isUnavailableWallet(ctx, walletAddress)) {
        return buildUnavailablePositionCheck();
      }

      const asset = ctx.assetsById.get(assetId);
      if (!asset?.tokenAddress) {
        return buildNotFoundPositionCheck();
      }

      if (ctx.mode === "live") {
        try {
          const balances = await getLiveBalancesOrThrow(adapter, walletAddress, authContext);
          const matchingBalance = balances.balances.find(
            (balance) => normalizeAddress(balance.token) === normalizeAddress(asset.tokenAddress!)
          );
          if (!matchingBalance) {
            return buildNotFoundPositionCheck();
          }

          const availableQuantity = onchainAmountToQuantity(matchingBalance.amount);
          return buildPositionCheck(availableQuantity, minQty);
        } catch {
          return buildUnavailablePositionCheck();
        }
      }

      const stubPosition = DEMO_POSITIONS.find(
        (position) =>
          normalizeAddress(position.walletAddress) === normalizeAddress(walletAddress) &&
          position.assetId === assetId
      );

      if (!stubPosition) {
        return buildNotFoundPositionCheck();
      }

      return buildPositionCheck(stubPosition.quantity, minQty);
    }
  };

  return adapter;
}

export function mapConvergenceBalancesToPortfolio(
  walletAddress: string,
  balances: ConvergenceBalancesResponse
): PortfolioPosition[] {
  return balances.balances
    .map((balance) => {
      const asset = DEMO_ASSETS.find(
        (candidate) =>
          candidate.tokenAddress &&
          normalizeAddress(candidate.tokenAddress) === normalizeAddress(balance.token)
      );
      if (!asset) return null;

      return PortfolioPositionSchema.parse({
        walletAddress,
        assetId: asset.assetId,
        tokenAddress: asset.tokenAddress,
        quantity: onchainAmountToQuantity(balance.amount),
        valuation: 0,
        symbol: asset.symbol,
        displayName: asset.displayName,
        valuationCurrency: asset.valuationCurrency,
        transferabilityFlag: asset.transferabilityFlag,
        complianceTags: asset.complianceTags
      });
    })
    .filter((position): position is PortfolioPosition => position !== null);
}

export function getAssetByTokenAddress(tokenAddress: string): ConvergenceAsset | null {
  const normalizedToken = normalizeAddress(tokenAddress);
  const asset = DEMO_ASSETS.find(
    (candidate) =>
      candidate.tokenAddress && normalizeAddress(candidate.tokenAddress) === normalizedToken
  );
  return asset ? ConvergenceAssetSchema.parse(asset) : null;
}

