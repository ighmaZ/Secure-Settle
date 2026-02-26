import type { ConvergenceBalancesRequest, ConvergenceEip712Domain } from "./types";
import { ConvergenceBalancesRequestSchema, ConvergenceEip712DomainSchema } from "./types";

export const CONVERGENCE_EIP712_DOMAIN: ConvergenceEip712Domain = ConvergenceEip712DomainSchema.parse(
  {
    // From the Convergence hackathon docs
    name: "CompliantPrivateTokenDemo",
    version: "0.0.1",
    chainId: 11155111,
    verifyingContract: "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13"
  }
);

export type Eip712TypedData = {
  domain: ConvergenceEip712Domain;
  primaryType: string;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
};

export function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function buildRetrieveBalancesTypedData(
  account: string,
  timestamp = unixNowSeconds(),
  domain: ConvergenceEip712Domain = CONVERGENCE_EIP712_DOMAIN
): Eip712TypedData {
  const msg = ConvergenceBalancesRequestSchema.parse({
    account,
    timestamp,
    auth: "0x00"
  });

  return {
    domain,
    primaryType: "Retrieve Balances",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      "Retrieve Balances": [
        { name: "account", type: "address" },
        { name: "timestamp", type: "uint256" }
      ]
    },
    message: {
      account: msg.account,
      timestamp: msg.timestamp
    }
  };
}

export function buildBalancesSignedRequest(input: ConvergenceBalancesRequest): ConvergenceBalancesRequest {
  return ConvergenceBalancesRequestSchema.parse(input);
}

