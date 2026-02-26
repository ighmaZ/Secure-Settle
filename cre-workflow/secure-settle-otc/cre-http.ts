import {
  consensusIdenticalAggregation,
  cre,
  json as readJsonBody,
  ok as isHttpOk,
  text as readTextBody,
  type Runtime as CreRuntime
} from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "./types";

const DEFAULT_HTTP_TIMEOUT_MS = 5000;

export type JsonHttpRequest = {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
};

export type JsonHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

function encodeUtf8AsBase64(value: string): string {
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
}

type HttpResponseHelpersInput = Parameters<typeof isHttpOk>[0];

function parseResponseBody(response: {
  statusCode: number;
  body: Uint8Array;
  headers: Record<string, string>;
}) {
  const helperCompatibleResponse = response as unknown as HttpResponseHelpersInput;

  if (isHttpOk(helperCompatibleResponse)) {
    return readJsonBody(helperCompatibleResponse);
  }

  // Best effort parse for structured errors, then fall back to plain text.
  try {
    return readJsonBody(helperCompatibleResponse);
  } catch {
    return { error: "http_error", error_details: readTextBody(helperCompatibleResponse) };
  }
}

function serializeConsensusResponse(response: JsonHttpResponse): string {
  return JSON.stringify(response);
}

function deserializeConsensusResponse(value: string): JsonHttpResponse {
  return JSON.parse(value) as JsonHttpResponse;
}

export function createCreJsonHttpRequester(runtime: CreRuntime<WorkflowConfig>) {
  const httpClient = new cre.capabilities.HTTPClient();

  return async function sendJsonRequest(request: JsonHttpRequest): Promise<JsonHttpResponse> {
    const invokeWithConsensus = httpClient.sendRequest<[JsonHttpRequest], string>(
      runtime,
      (sendRequester, req) => {
        const rawResponse = sendRequester
          .sendRequest({
            url: req.url,
            method: req.method,
            headers: req.headers ?? {},
            body: encodeUtf8AsBase64(JSON.stringify(req.body)),
            timeoutMs: req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
          })
          .result();

        return serializeConsensusResponse({
          statusCode: rawResponse.statusCode,
          headers: rawResponse.headers,
          body: parseResponseBody(rawResponse)
        });
      },
      consensusIdenticalAggregation<string>()
    );

    return deserializeConsensusResponse(invokeWithConsensus(request).result());
  };
}
