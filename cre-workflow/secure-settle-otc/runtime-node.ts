import type { RuntimeLike } from "./types";

export function createRuntimeLogger(): RuntimeLike {
  return {
    log(message, details) {
      if (details === undefined) {
        console.log(`[secure-settle-cre] ${message}`);
        return;
      }
      console.log(`[secure-settle-cre] ${message}`, details);
    },
    async report(payload) {
      console.log("[secure-settle-cre] report", payload);
    }
  };
}

