import type { ProposalPayload, PortfolioPosition, ConvergenceAsset } from "./types";

export const DEMO_PROPOSALS: ProposalPayload[] = [
  {
    walletAddress: "0x1111111111111111111111111111111111111111",
    role: "BUYER",
    side: "BUY",
    assetId: "rwa-maple-private-credit-001",
    quantity: 100,
    price: 99.5,
    settlementToken: "USDC",
    optionalConditions: [{ field: "fxRate", operator: "<=", value: 1.1 }],
    encryptedPayloadRef: "enc://proposal/buyer-001"
  },
  {
    walletAddress: "0x2222222222222222222222222222222222222222",
    role: "SELLER",
    side: "SELL",
    assetId: "rwa-maple-private-credit-001",
    quantity: 100,
    price: 100.2,
    settlementToken: "USDC",
    optionalConditions: [],
    encryptedPayloadRef: "enc://proposal/seller-001"
  },
  {
    walletAddress: "0x3333333333333333333333333333333333333333",
    role: "SELLER",
    side: "SELL",
    assetId: "rwa-corp-bond-002",
    quantity: 50,
    price: 101.25,
    settlementToken: "USDC",
    optionalConditions: [],
    encryptedPayloadRef: "enc://proposal/seller-002"
  }
];

export const DEMO_POSITIONS: PortfolioPosition[] = [
  {
    walletAddress: "0x2222222222222222222222222222222222222222",
    assetId: "rwa-maple-private-credit-001",
    tokenAddress: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    quantity: 500,
    valuation: 50000,
    symbol: "MPCRED",
    displayName: "Maple Private Credit Position 001",
    valuationCurrency: "USD",
    transferabilityFlag: true,
    complianceTags: ["institutional"]
  },
  {
    walletAddress: "0x3333333333333333333333333333333333333333",
    assetId: "rwa-corp-bond-002",
    tokenAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    quantity: 10,
    valuation: 1000,
    symbol: "CBOND2",
    displayName: "Corporate Bond Series 2",
    valuationCurrency: "USD",
    transferabilityFlag: true,
    complianceTags: ["institutional"]
  }
];

export const DEMO_ASSETS: ConvergenceAsset[] = [
  {
    assetId: "rwa-maple-private-credit-001",
    tokenAddress: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    symbol: "MPCRED",
    displayName: "Maple Private Credit Position 001",
    valuationCurrency: "USD",
    transferabilityFlag: true,
    complianceTags: ["institutional"]
  },
  {
    assetId: "rwa-corp-bond-002",
    tokenAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "CBOND2",
    displayName: "Corporate Bond Series 2",
    valuationCurrency: "USD",
    transferabilityFlag: true,
    complianceTags: ["institutional"]
  }
];
