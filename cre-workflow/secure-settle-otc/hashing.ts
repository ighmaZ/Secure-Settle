// Deterministic stub hash for local workflow simulation.
// This is not cryptographic and should be replaced with a CRE-supported hash/runtime helper
// when wiring the real Confidential Compute / attestation pipeline.
function fnv1a32(input: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function toHex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

export function deterministicHexHash(input: string): string {
  const parts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    parts.push(toHex32(fnv1a32(input, i * 0x9e3779b9)));
  }
  return `0x${parts.join("")}`;
}

