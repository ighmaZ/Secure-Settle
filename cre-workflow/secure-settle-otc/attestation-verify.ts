import {
  AttestationEvidenceSchema,
  AttestationVerificationResultSchema,
  type AttestationEvidence,
  type AttestationVerificationResult,
  type AttestedMatchResult,
  type ConfidentialChallenge,
  type WorkflowConfig
} from "./types";
import {
  hmacSha256Hex,
  pemToDerBytes,
  sha256Hex,
  stableJson,
  verifyEcdsaP256Sha256Signature
} from "./crypto-primitives";
import { requireAttestationSigningKeyHex } from "./security-material";

type AttestationSignedPayload = {
  signerKeyId: string;
  measurement: string;
  nonce: string;
  inputHash: string;
  resultHash: string;
  issuedAt: string;
};

type QuoteVerifierHook = (evidence: AttestationEvidence) => Promise<boolean>;

function canonicalAttestationPayload(payload: AttestationSignedPayload): string {
  return stableJson(payload);
}

function verificationSuccess(
  reasonCode: AttestationVerificationResult["reasonCode"] = "OK"
): AttestationVerificationResult {
  return AttestationVerificationResultSchema.parse({
    ok: true,
    reasonCode,
    verifiedAt: new Date().toISOString()
  });
}

function verificationFailure(
  reasonCode: AttestationVerificationResult["reasonCode"]
): AttestationVerificationResult {
  return AttestationVerificationResultSchema.parse({
    ok: false,
    reasonCode,
    verifiedAt: new Date().toISOString()
  });
}

function allowedMeasurements(config: WorkflowConfig): Set<string> {
  const configured = config.attestation.allowedMeasurements;
  return new Set(configured.length > 0 ? configured : [config.attestation.expectedMeasurement]);
}

function signerKeyIdsTrustIsConfigured(config: WorkflowConfig): boolean {
  return config.attestation.trustedSignerKeyIds.length > 0;
}

function isTrustedSignerKeyId(config: WorkflowConfig, signerKeyId: string): boolean {
  if (!signerKeyIdsTrustIsConfigured(config)) {
    return signerKeyId === config.attestation.signerKeyId;
  }
  return config.attestation.trustedSignerKeyIds.includes(signerKeyId);
}

async function hasTrustedCertificateFingerprint(
  config: WorkflowConfig,
  certChainPem: string[] | undefined
): Promise<boolean> {
  const trustedFingerprints = config.attestation.trustedCertFingerprintsSha256;
  if (trustedFingerprints.length === 0) {
    return true;
  }
  if (!certChainPem || certChainPem.length === 0) {
    return false;
  }

  const trusted = new Set(trustedFingerprints.map((value) => value.toLowerCase()));
  for (const pem of certChainPem) {
    const derFingerprint = (await sha256Hex(pemToDerBytes(pem))).toLowerCase();
    if (trusted.has(derFingerprint)) {
      return true;
    }
  }
  return false;
}

async function computeResultHashWithoutEvidence(result: AttestedMatchResult): Promise<string> {
  const {
    attestationEvidence: _ignoredEvidence,
    attestationHash: _ignoredAttestationHash,
    ...unsignedResult
  } = result;
  return sha256Hex(stableJson(unsignedResult));
}

function validateAttestationClaims(
  config: WorkflowConfig,
  evidence: AttestationEvidence,
  challenge: ConfidentialChallenge,
  resultHash: string
): AttestationVerificationResult | null {
  if (!allowedMeasurements(config).has(evidence.measurement)) {
    return verificationFailure("INVALID_MEASUREMENT");
  }

  if (!isTrustedSignerKeyId(config, evidence.signerKeyId)) {
    return verificationFailure("UNTRUSTED_SIGNER");
  }

  const issuedAtMs = Date.parse(evidence.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return verificationFailure("ATTESTATION_EXPIRED");
  }
  if (Math.abs(Date.now() - issuedAtMs) > config.attestation.maxAgeSeconds * 1000) {
    return verificationFailure("ATTESTATION_EXPIRED");
  }

  if (evidence.nonce !== challenge.nonce) {
    return verificationFailure("NONCE_MISMATCH");
  }
  if (evidence.inputHash !== challenge.inputHash) {
    return verificationFailure("INPUT_HASH_MISMATCH");
  }
  if (evidence.resultHash.toLowerCase() !== resultHash.toLowerCase()) {
    return verificationFailure("RESULT_HASH_MISMATCH");
  }

  return null;
}

async function verifyStubHmacEvidence(input: {
  config: WorkflowConfig;
  evidence: AttestationEvidence;
}): Promise<AttestationVerificationResult> {
  const expectedSignature = await hmacSha256Hex(
    requireAttestationSigningKeyHex(input.config),
    canonicalAttestationPayload({
      signerKeyId: input.evidence.signerKeyId,
      measurement: input.evidence.measurement,
      nonce: input.evidence.nonce,
      inputHash: input.evidence.inputHash,
      resultHash: input.evidence.resultHash,
      issuedAt: input.evidence.issuedAt
    })
  );

  if (!input.evidence.signatureHex) {
    return verificationFailure("SIGNATURE_INVALID");
  }

  if (expectedSignature.toLowerCase() !== input.evidence.signatureHex.toLowerCase()) {
    return verificationFailure("SIGNATURE_INVALID");
  }

  return verificationSuccess();
}

async function verifySignedStatementEvidence(input: {
  config: WorkflowConfig;
  evidence: AttestationEvidence;
}): Promise<AttestationVerificationResult> {
  if (
    !input.evidence.statementSignatureBase64 ||
    input.evidence.statementAlgorithm !== "ECDSA_P256_SHA256" ||
    !input.evidence.signerPublicKeySpkiPem
  ) {
    return verificationFailure("SIGNATURE_INVALID");
  }

  const certTrustOk = await hasTrustedCertificateFingerprint(input.config, input.evidence.certChainPem);
  if (!certTrustOk) {
    return verificationFailure("CERT_CHAIN_INVALID");
  }

  const verified = await verifyEcdsaP256Sha256Signature({
    spkiPem: input.evidence.signerPublicKeySpkiPem,
    message: canonicalAttestationPayload({
      signerKeyId: input.evidence.signerKeyId,
      measurement: input.evidence.measurement,
      nonce: input.evidence.nonce,
      inputHash: input.evidence.inputHash,
      resultHash: input.evidence.resultHash,
      issuedAt: input.evidence.issuedAt
    }),
    signatureBase64: input.evidence.statementSignatureBase64
  });

  return verified ? verificationSuccess() : verificationFailure("SIGNATURE_INVALID");
}

async function verifyTeeQuoteEvidence(input: {
  config: WorkflowConfig;
  evidence: AttestationEvidence;
  quoteVerifier?: QuoteVerifierHook;
}): Promise<AttestationVerificationResult> {
  const certTrustOk = await hasTrustedCertificateFingerprint(input.config, input.evidence.certChainPem);
  if (!certTrustOk) {
    return verificationFailure("CERT_CHAIN_INVALID");
  }

  if (input.quoteVerifier) {
    const ok = await input.quoteVerifier(input.evidence);
    return ok ? verificationSuccess() : verificationFailure("QUOTE_VERIFICATION_FAILED");
  }

  if (!input.evidence.quoteVerifierReport?.verified) {
    return verificationFailure("QUOTE_VERIFICATION_FAILED");
  }

  return verificationSuccess();
}

export async function createStubAttestationEvidence(input: {
  config: WorkflowConfig;
  challenge: ConfidentialChallenge;
  result: Omit<AttestedMatchResult, "attestationEvidence" | "attestationHash">;
  issuedAt: string;
}): Promise<AttestationEvidence> {
  const resultHash = await sha256Hex(stableJson(input.result));
  const payload: AttestationSignedPayload = {
    signerKeyId: input.config.attestation.signerKeyId,
    measurement: input.config.attestation.expectedMeasurement,
    nonce: input.challenge.nonce,
    inputHash: input.challenge.inputHash,
    resultHash,
    issuedAt: input.issuedAt
  };

  const signatureHex = await hmacSha256Hex(
    requireAttestationSigningKeyHex(input.config),
    canonicalAttestationPayload(payload)
  );

  return AttestationEvidenceSchema.parse({
    scheme: "stub-hmac-sha256",
    ...payload,
    signatureHex
  });
}

export async function verifyAttestationEvidence(input: {
  config: WorkflowConfig;
  result: AttestedMatchResult;
  expectedChallenge: ConfidentialChallenge;
  quoteVerifier?: QuoteVerifierHook;
}): Promise<AttestationVerificationResult> {
  const policy = input.config.attestation;
  if (!policy.requireVerification) {
    return verificationSuccess("DISABLED");
  }

  const evidence = input.result.attestationEvidence;
  if (!evidence) {
    return verificationFailure("MISSING_EVIDENCE");
  }

  const normalizedEvidence = AttestationEvidenceSchema.parse(evidence);
  const resultHash = await computeResultHashWithoutEvidence(input.result);

  const claimsFailure = validateAttestationClaims(
    input.config,
    normalizedEvidence,
    input.expectedChallenge,
    resultHash
  );
  if (claimsFailure) {
    return claimsFailure;
  }

  switch (normalizedEvidence.scheme) {
    case "stub-hmac-sha256":
      return verifyStubHmacEvidence({ config: input.config, evidence: normalizedEvidence });
    case "signed-statement-v1":
      return verifySignedStatementEvidence({ config: input.config, evidence: normalizedEvidence });
    case "tee-quote-v1":
      return verifyTeeQuoteEvidence({
        config: input.config,
        evidence: normalizedEvidence,
        quoteVerifier: input.quoteVerifier
      });
    default:
      return verificationFailure("UNSUPPORTED_SCHEME");
  }
}
