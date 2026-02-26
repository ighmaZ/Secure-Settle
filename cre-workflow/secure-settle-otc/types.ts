import { z } from "zod";

export const ProposalStatusSchema = z.enum([
  "SUBMITTED",
  "QUEUED",
  "MATCHING",
  "NO_MATCH",
  "MATCH_PENDING_CONFIRMATION",
  "REJECTED_COMPLIANCE",
  "PENDING_RETRY",
  "CONFIRMED",
  "SETTLING",
  "SETTLED"
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const MatchDecisionSchema = z.enum([
  "MATCH",
  "NO_MATCH",
  "REJECTED_COMPLIANCE",
  "PENDING_RETRY"
]);
export type MatchDecision = z.infer<typeof MatchDecisionSchema>;

export const SettlementStatusSchema = z.enum([
  "NOT_READY",
  "READY",
  "PENDING_ONCHAIN",
  "SETTLED",
  "FAILED"
]);
export type SettlementStatus = z.infer<typeof SettlementStatusSchema>;

export const ProposalSideSchema = z.enum(["BUY", "SELL"]);
export type ProposalSide = z.infer<typeof ProposalSideSchema>;

export const OptionalConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([">", ">=", "<", "<=", "=="]),
  value: z.union([z.number(), z.string(), z.boolean()])
});
export type OptionalCondition = z.infer<typeof OptionalConditionSchema>;

export const EncryptedProposalEnvelopeSchema = z.object({
  version: z.literal("v1"),
  algorithm: z.literal("AES-256-GCM"),
  keyId: z.string().min(1),
  ivHex: z.string().regex(/^0x[a-fA-F0-9]{24}$/),
  ciphertextHex: z.string().regex(/^0x[a-fA-F0-9]+$/),
  aadJson: z.string().min(1),
  plaintextHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/)
});
export type EncryptedProposalEnvelope = z.infer<typeof EncryptedProposalEnvelopeSchema>;

export const ConfidentialChallengeSchema = z.object({
  nonce: z.string().regex(/^0x[a-fA-F0-9]{32}$/),
  inputHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  issuedAt: z.string().datetime()
});
export type ConfidentialChallenge = z.infer<typeof ConfidentialChallengeSchema>;

export const AttestationEvidenceSchema = z
  .object({
    scheme: z.enum(["stub-hmac-sha256", "signed-statement-v1", "tee-quote-v1"]),
    signerKeyId: z.string().min(1),
    measurement: z.string().min(1),
    nonce: z.string().regex(/^0x[a-fA-F0-9]{32}$/),
    inputHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    resultHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    issuedAt: z.string().datetime(),
    signatureHex: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    statementSignatureBase64: z.string().min(1).optional(),
    statementAlgorithm: z.enum(["ECDSA_P256_SHA256"]).optional(),
    signerPublicKeySpkiPem: z.string().min(1).optional(),
    certChainPem: z.array(z.string().min(1)).optional(),
    quoteBodyBase64: z.string().min(1).optional(),
    quoteFormat: z.string().min(1).optional(),
    quoteVerifierReport: z
      .object({
        verifier: z.string().min(1),
        verified: z.boolean(),
        reportHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional()
      })
      .optional()
  })
  .superRefine((value, ctx) => {
    if (value.scheme === "stub-hmac-sha256" && !value.signatureHex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stub-hmac-sha256 evidence requires signatureHex"
      });
    }

    if (
      value.scheme === "signed-statement-v1" &&
      (!value.statementSignatureBase64 || !value.statementAlgorithm || !value.signerPublicKeySpkiPem)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "signed-statement-v1 evidence requires statementSignatureBase64, statementAlgorithm, and signerPublicKeySpkiPem"
      });
    }

    if (value.scheme === "tee-quote-v1" && !value.quoteBodyBase64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tee-quote-v1 evidence requires quoteBodyBase64"
      });
    }
  });
export type AttestationEvidence = z.infer<typeof AttestationEvidenceSchema>;

export const ProposalPayloadSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  role: z.enum(["BUYER", "SELLER"]),
  side: ProposalSideSchema,
  assetId: z.string().min(1),
  quantity: z.number().positive(),
  price: z.number().positive(),
  settlementToken: z.string().min(1),
  optionalConditions: z.array(OptionalConditionSchema).default([]),
  convergenceBalancesAuth: z
    .object({
      account: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      timestamp: z.number().int().positive(),
      auth: z.string().regex(/^0x[a-fA-F0-9]*$/)
    })
    .optional(),
  encryptedPayloadRef: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export const ProposalRoutingMetadataSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  role: z.enum(["BUYER", "SELLER"]),
  side: ProposalSideSchema,
  assetId: z.string().min(1),
  settlementToken: z.string().min(1)
});
export type ProposalRoutingMetadata = z.infer<typeof ProposalRoutingMetadataSchema>;

export const ProposalRecordSchema = ProposalRoutingMetadataSchema.extend({
  id: z.string().min(1),
  status: ProposalStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  encryptedPayloadRef: z.string().min(1),
  encryptedPayload: EncryptedProposalEnvelopeSchema,
  evaluationNotes: z.array(z.string()).default([])
});
export type ProposalRecord = z.infer<typeof ProposalRecordSchema>;

export const MatchCandidateSchema = z.object({
  id: z.string().min(1),
  proposalBuyId: z.string().min(1),
  proposalSellId: z.string().min(1),
  assetId: z.string().min(1)
});
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;

export const ComplianceCheckResultSchema = z.object({
  passed: z.boolean(),
  reasonCode: z
    .enum([
      "NONE",
      "SANCTIONS_HIT",
      "INSUFFICIENT_POSITION",
      "AML_THRESHOLD_EXCEEDED",
      "CONVERGENCE_UNAVAILABLE"
    ])
    .default("NONE"),
  amlFlag: z.boolean().default(false),
  sanctionsHit: z.boolean().default(false),
  positionVerified: z.boolean().default(false)
});
export type ComplianceCheckResult = z.infer<typeof ComplianceCheckResultSchema>;

export const MaskedSummarySchema = z.object({
  proposalId: z.string(),
  assetId: z.string(),
  side: ProposalSideSchema,
  quantityBand: z.string(),
  priceBand: z.string(),
  settlementToken: z.string(),
  statusMessage: z.string()
});
export type MaskedSummary = z.infer<typeof MaskedSummarySchema>;

export const AttestedMatchResultSchema = z.object({
  matchId: z.string(),
  proposalBuyId: z.string(),
  proposalSellId: z.string(),
  decision: MatchDecisionSchema,
  termsHash: z.string(),
  attestationHash: z.string(),
  reasonCode: z.string(),
  compliance: ComplianceCheckResultSchema,
  maskedSummaryBuyer: MaskedSummarySchema,
  maskedSummarySeller: MaskedSummarySchema,
  attestationEvidence: AttestationEvidenceSchema,
  createdAt: z.string().datetime()
});
export type AttestedMatchResult = z.infer<typeof AttestedMatchResultSchema>;

export const WorkflowStatusViewSchema = z.object({
  entityType: z.enum(["proposal", "match"]),
  id: z.string(),
  status: z.string(),
  nextAction: z.string(),
  maskedSummary: MaskedSummarySchema.optional(),
  errorCode: z.string().optional(),
  updatedAt: z.string().datetime()
});
export type WorkflowStatusView = z.infer<typeof WorkflowStatusViewSchema>;

export const SettlementInstructionBundleSchema = z.object({
  matchId: z.string(),
  matchHash: z.string(),
  attestationHash: z.string(),
  buyer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  seller: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  paymentToken: z.string(),
  paymentAmount: z.number().positive(),
  chainId: z.number().int().positive()
});
export type SettlementInstructionBundle = z.infer<typeof SettlementInstructionBundleSchema>;

export const EvmConfigSchema = z.object({
  chainId: z.number().int().positive(),
  chainName: z.string().min(1),
  rpcUrlEnv: z.string().min(1),
  settlementContractAddress: z.string().nullable(),
  gasLimit: z.number().int().positive()
});
export type EvmConfig = z.infer<typeof EvmConfigSchema>;

export const WorkflowConfigSchema = z.object({
  workflowId: z.string().min(1),
  evms: z.array(EvmConfigSchema).min(1),
  matching: z.object({
    priceToleranceBps: z.number().int().min(0).max(10000),
    proposalExpiryMinutes: z.number().int().positive(),
    scanIntervalSeconds: z.number().int().positive(),
    allowPartialFills: z.boolean().default(false)
  }),
  compliance: z.object({
    amlVolumeThreshold: z.number().positive(),
    sanctionsSourceMode: z.enum(["mock", "live"]),
    sanctionedWallets: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).default([])
  }),
  convergence: z.object({
    baseUrl: z.string().url(),
    authMode: z.enum(["none", "eip712", "bearer"]).default("eip712"),
    mode: z.enum(["stub", "live"]).default("stub"),
    timeoutMs: z.number().int().positive()
  }),
  confidentialCompute: z.object({
    mode: z.enum(["stub", "http"]).default("stub"),
    endpointUrl: z.string().url().nullable().default(null),
    timeoutMs: z.number().int().positive().default(5000),
    authHeaderSecretName: z.string().min(1).nullable().default(null)
  }),
  proposalEncryption: z.object({
    mode: z.enum(["aes-gcm"]).default("aes-gcm"),
    keyId: z.string().min(1).default("dev-proposal-key-v1"),
    masterKeyHex: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().default(null),
    masterKeySecretName: z.string().min(1).nullable().default(null),
    devFallbackMasterKeyHex: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().default(null)
  }),
  attestation: z.object({
    mode: z.enum(["stub-hmac-sha256", "signed-statement-v1", "tee-quote-v1"]).default("stub-hmac-sha256"),
    signerKeyId: z.string().min(1).default("dev-attestor-v1"),
    signingKeyHex: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().default(null),
    signingKeySecretName: z.string().min(1).nullable().default(null),
    devFallbackSigningKeyHex: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().default(null),
    expectedMeasurement: z.string().min(1).default("secure-settle/confidential-stub/v1"),
    allowedMeasurements: z.array(z.string().min(1)).default([]),
    trustedSignerKeyIds: z.array(z.string().min(1)).default([]),
    trustedCertFingerprintsSha256: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)).default([]),
    maxAgeSeconds: z.number().int().positive().default(300),
    requireVerification: z.boolean().default(true)
  }),
  storage: z.object({
    provider: z.enum(["local-file"]),
    dataPath: z.string().min(1)
  }),
  demo: z.object({
    seedOnEmpty: z.boolean().default(true),
    clockSkewToleranceSeconds: z.number().int().nonnegative().default(0),
    allowBootstrapAdapters: z.boolean().default(false)
  })
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
export type WorkflowConfigInput = z.input<typeof WorkflowConfigSchema>;

export const ConvergenceAssetSchema = z.object({
  assetId: z.string(),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  symbol: z.string(),
  displayName: z.string(),
  valuationCurrency: z.string(),
  transferabilityFlag: z.boolean().default(true),
  complianceTags: z.array(z.string()).default([])
});
export type ConvergenceAsset = z.infer<typeof ConvergenceAssetSchema>;

export const PortfolioPositionSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  assetId: z.string(),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  quantity: z.number().nonnegative(),
  valuation: z.number().nonnegative(),
  symbol: z.string(),
  displayName: z.string(),
  valuationCurrency: z.string(),
  transferabilityFlag: z.boolean(),
  complianceTags: z.array(z.string())
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PositionCheckResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["OK", "INSUFFICIENT_POSITION", "NOT_FOUND", "UNAVAILABLE"]),
  availableQuantity: z.number().nonnegative().default(0)
});
export type PositionCheckResult = z.infer<typeof PositionCheckResultSchema>;

const HexAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const HexBytesSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const ConvergenceSignedRequestBaseSchema = z.object({
  timestamp: z.number().int().positive(),
  auth: HexBytesSchema
});
export type ConvergenceSignedRequestBase = z.infer<typeof ConvergenceSignedRequestBaseSchema>;

export const ConvergenceBalancesRequestSchema = ConvergenceSignedRequestBaseSchema.extend({
  account: HexAddressSchema
});
export type ConvergenceBalancesRequest = z.infer<typeof ConvergenceBalancesRequestSchema>;

export const ConvergenceBalanceItemSchema = z.object({
  token: HexAddressSchema,
  amount: z.string().regex(/^\d+$/)
});
export type ConvergenceBalanceItem = z.infer<typeof ConvergenceBalanceItemSchema>;

export const ConvergenceBalancesResponseSchema = z.object({
  balances: z.array(ConvergenceBalanceItemSchema)
});
export type ConvergenceBalancesResponse = z.infer<typeof ConvergenceBalancesResponseSchema>;

export const ConvergenceTransactionsRequestSchema = ConvergenceSignedRequestBaseSchema.extend({
  account: HexAddressSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional()
});
export type ConvergenceTransactionsRequest = z.infer<typeof ConvergenceTransactionsRequestSchema>;

export const ConvergenceTransactionSchema = z.object({
  id: z.string(),
  type: z.enum(["deposit", "withdrawal", "transfer"]),
  account: HexAddressSchema.optional(),
  sender: HexAddressSchema.optional(),
  recipient: HexAddressSchema.optional(),
  token: HexAddressSchema,
  amount: z.string().regex(/^\d+$/),
  tx_hash: HexBytesSchema.optional(),
  is_incoming: z.boolean().optional(),
  is_sender_hidden: z.boolean().optional(),
  withdraw_status: z.enum(["pending", "completed", "refunded"]).optional()
});
export type ConvergenceTransaction = z.infer<typeof ConvergenceTransactionSchema>;

export const ConvergenceTransactionsResponseSchema = z.object({
  transactions: z.array(ConvergenceTransactionSchema),
  has_more: z.boolean(),
  next_cursor: z.string().optional()
});
export type ConvergenceTransactionsResponse = z.infer<typeof ConvergenceTransactionsResponseSchema>;

export const ConvergencePrivateTransferRequestSchema = ConvergenceSignedRequestBaseSchema.extend({
  account: HexAddressSchema,
  recipient: HexAddressSchema,
  token: HexAddressSchema,
  amount: z.string().regex(/^\d+$/),
  flags: z.array(z.string()).default([])
});
export type ConvergencePrivateTransferRequest = z.infer<
  typeof ConvergencePrivateTransferRequestSchema
>;

export const ConvergencePrivateTransferResponseSchema = z.object({
  transaction_id: z.string()
});
export type ConvergencePrivateTransferResponse = z.infer<
  typeof ConvergencePrivateTransferResponseSchema
>;

export const ConvergenceWithdrawRequestSchema = ConvergenceSignedRequestBaseSchema.extend({
  account: HexAddressSchema,
  token: HexAddressSchema,
  amount: z.string().regex(/^\d+$/)
});
export type ConvergenceWithdrawRequest = z.infer<typeof ConvergenceWithdrawRequestSchema>;

export const ConvergenceWithdrawResponseSchema = z.object({
  id: z.string(),
  account: HexAddressSchema,
  token: HexAddressSchema,
  amount: z.string().regex(/^\d+$/),
  deadline: z.number().int().positive(),
  ticket: HexBytesSchema
});
export type ConvergenceWithdrawResponse = z.infer<typeof ConvergenceWithdrawResponseSchema>;

export const ConvergenceShieldedAddressRequestSchema = ConvergenceSignedRequestBaseSchema.extend({
  account: HexAddressSchema
});
export type ConvergenceShieldedAddressRequest = z.infer<
  typeof ConvergenceShieldedAddressRequestSchema
>;

export const ConvergenceShieldedAddressResponseSchema = z.object({
  address: HexAddressSchema
});
export type ConvergenceShieldedAddressResponse = z.infer<
  typeof ConvergenceShieldedAddressResponseSchema
>;

export const ConvergenceErrorResponseSchema = z.object({
  error: z.string(),
  error_details: z.string(),
  request_id: z.string()
});
export type ConvergenceErrorResponse = z.infer<typeof ConvergenceErrorResponseSchema>;

export const ConvergenceEip712DomainSchema = z.object({
  name: z.string(),
  version: z.string(),
  chainId: z.number().int().positive(),
  verifyingContract: HexAddressSchema
});
export type ConvergenceEip712Domain = z.infer<typeof ConvergenceEip712DomainSchema>;

export const ConfidentialComputeHttpRequestSchema = z.object({
  candidateId: z.string(),
  buyProposal: ProposalRecordSchema,
  sellProposal: ProposalRecordSchema,
  challenge: ConfidentialChallengeSchema,
  evaluationTimestamp: z.string().datetime(),
  matching: z.object({
    priceToleranceBps: z.number().int().min(0).max(10000),
    allowPartialFills: z.boolean()
  }),
  compliance: z.object({
    amlVolumeThreshold: z.number().positive(),
    sanctionsSourceMode: z.enum(["mock", "live"])
  })
});
export type ConfidentialComputeHttpRequest = z.infer<typeof ConfidentialComputeHttpRequestSchema>;

export const ConfidentialComputeHttpResponseSchema = AttestedMatchResultSchema;
export type ConfidentialComputeHttpResponse = z.infer<typeof ConfidentialComputeHttpResponseSchema>;

export const AttestationVerificationResultSchema = z.object({
  ok: z.boolean(),
  reasonCode: z.enum([
    "OK",
    "DISABLED",
    "MISSING_EVIDENCE",
    "INVALID_MEASUREMENT",
    "ATTESTATION_EXPIRED",
    "NONCE_MISMATCH",
    "INPUT_HASH_MISMATCH",
    "RESULT_HASH_MISMATCH",
    "SIGNATURE_INVALID",
    "UNTRUSTED_SIGNER",
    "CERT_CHAIN_INVALID",
    "QUOTE_VERIFICATION_FAILED",
    "UNSUPPORTED_SCHEME"
  ]),
  verifiedAt: z.string().datetime()
});
export type AttestationVerificationResult = z.infer<typeof AttestationVerificationResultSchema>;

export const LocalStoreSchema = z.object({
  proposals: z.array(ProposalRecordSchema),
  matches: z.array(AttestedMatchResultSchema),
  workflowEvents: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      message: z.string(),
      createdAt: z.string().datetime(),
      redacted: z.boolean().default(true)
    })
  )
});
export type LocalStore = z.infer<typeof LocalStoreSchema>;

export type RuntimeLike = {
  log: (message: string, details?: unknown) => void;
  report?: (payload: unknown) => Promise<void> | void;
};

export function nowIso(): string {
  return new Date().toISOString();
}
