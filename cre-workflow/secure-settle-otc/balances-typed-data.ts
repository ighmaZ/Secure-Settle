import { buildRetrieveBalancesTypedData, unixNowSeconds } from "./convergence-eip712";

function usage() {
  console.log(
    "Usage: bun run balances-typed-data <account> [--timestamp=<unix-seconds>]\n" +
      "Prints EIP-712 typed data for Convergence POST /balances (sign with eth_signTypedData_v4)."
  );
}

async function run() {
  const [account, ...rest] = process.argv.slice(2);
  if (!account) {
    usage();
    process.exitCode = 1;
    return;
  }

  const timestampArg = rest.find((arg) => arg.startsWith("--timestamp="));
  const timestamp = timestampArg ? Number(timestampArg.slice("--timestamp=".length)) : unixNowSeconds();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error("Invalid timestamp");
  }

  const typedData = buildRetrieveBalancesTypedData(account, Math.floor(timestamp));
  console.log(JSON.stringify(typedData, null, 2));
  console.log(
    "\nAfter signing, send POST /balances with:\n" +
      JSON.stringify(
        {
          account,
          timestamp: Math.floor(timestamp),
          auth: "0x<signature>"
        },
        null,
        2
      )
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

