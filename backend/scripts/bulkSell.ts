// @ts-nocheck
import { mkdir, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readWalletCsv } from "./lib/csv.js";
import { estimateSwap, executeSwap, simulateSwap } from "../swaps.js";
import { describePair } from "../services/dex.js";
import { fromBaseUnits } from "../lib/amount.js";

const LCD_URL = process.env.LCD_URL || "https://zigchain-mainnet-lcd.zigscan.net";
const MAX_SEQUENCE_RETRY = 3;
const MAX_SPREAD_RETRY = 3;

function usage() {
  console.log(`Usage:
  node dist/backend/scripts/bulkSell.js --file=./wallets.csv --denom=coin.zig... --slippage=0.5 [--pair=zig1...] [--concurrency=3] [--dry-run] [--out=./results.json]
  node dist/backend/scripts/bulkSell.js --interactive

Options:
  --file          CSV path with walletAddress/privateKey columns
  --denom         Token denom to sell
  --pair          Pair contract address; if omitted, auto-resolve against uzig
  --slippage      Slippage percent, e.g. 0.5
  --concurrency   Parallel wallet workers, default 3
  --dry-run       Simulate only; do not broadcast
  --out           Optional result path (.json or .csv)
  --interactive   Prompt for missing values in terminal
  --help          Show this help
`);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    if (eqIndex === -1) {
      args[withoutPrefix] = true;
      continue;
    }
    const key = withoutPrefix.slice(0, eqIndex);
    const value = withoutPrefix.slice(eqIndex + 1);
    args[key] = value;
  }

  return {
    file: String(args.file || ""),
    denom: String(args.denom || ""),
    pair: args.pair ? String(args.pair) : "",
    slippage: Number(args.slippage ?? "0.5"),
    concurrency: Math.max(1, Number(args.concurrency ?? "3") || 3),
    dryRun: Boolean(args["dry-run"]),
    out: args.out ? String(args.out) : "",
    interactive: Boolean(args.interactive),
    help: Boolean(args.help),
  };
}

async function promptForOptions(options: any) {
  const rl = createInterface({ input, output });

  const ask = async (label: string, fallback = "") => {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback;
  };

  try {
    let detectedFile = "";
    if (!options.file) {
      const entries = await readdir(process.cwd(), { withFileTypes: true });
      const csvFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
        .map((entry) => `./${entry.name}`);
      if (csvFiles.length === 1) {
        detectedFile = csvFiles[0];
        console.log(`Using detected CSV: ${detectedFile}`);
      }
    }

    const file = options.file || detectedFile || (await ask("CSV file path", "./Book1.csv"));
    const denom = options.denom || (await ask("Token denom to sell"));
    const pair = options.pair || (await ask("Pair contract (leave blank for auto-resolve)", ""));
    const slippageText =
      options.slippage > 0 && !Number.isNaN(options.slippage)
        ? String(options.slippage)
        : await ask("Slippage percent", "0.5");
    const concurrencyText =
      options.concurrency > 0 && !Number.isNaN(options.concurrency)
        ? String(options.concurrency)
        : await ask("Concurrency", "3");
    const out = options.out || (await ask("Result output path (optional)", ""));
    const dryRunAnswer =
      options.dryRun
        ? "y"
        : await ask("Dry run only? (y/n)", "y");

    return {
      ...options,
      file,
      denom,
      pair,
      slippage: Number(slippageText || "0.5"),
      concurrency: Math.max(1, Number(concurrencyText || "3") || 3),
      out,
      dryRun: /^y(es)?$/i.test(dryRunAnswer),
    };
  } finally {
    rl.close();
  }
}

function isValidWalletAddress(address: string) {
  return typeof address === "string" && address.trim().startsWith("zig1") && address.trim().length === 42;
}

function normalizePrivateKey(privateKey: string) {
  const normalized = privateKey.trim().startsWith("0x")
    ? privateKey.trim().slice(2)
    : privateKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Private key must be 64 hex characters with optional 0x prefix.");
  }
  return normalized.toLowerCase();
}

function formatPercent(slippage: number) {
  return `${Number(slippage).toFixed(2)}%`;
}

function logPrefix(index: number, total: number, walletAddress: string) {
  return `[${index}/${total}] ${walletAddress}`;
}

function getAssetType(denom: string) {
  if (denom === "uzig" || denom.startsWith("coin.") || denom.startsWith("ibc/")) {
    return "native";
  }
  return "cw20";
}

function isSequenceMismatchError(error: unknown) {
  const msg = String((error as Error)?.message || "").toLowerCase();
  return (
    msg.includes("account sequence mismatch") ||
    msg.includes("incorrect account sequence") ||
    msg.includes("code 32")
  );
}

function isSpreadError(error: unknown) {
  const msg = String((error as Error)?.message || "").toLowerCase();
  return (
    msg.includes("max spread assertion") ||
    msg.includes("spread limit") ||
    msg.includes("operation exceeds max spread")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSpendableBalance(walletAddress: string, denom: string) {
  const url = `${LCD_URL}/cosmos/bank/v1beta1/spendable_balances/${walletAddress}/by_denom?denom=${encodeURIComponent(denom)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Balance query failed (${response.status})`);
  }
  const body = await response.json();
  return body.balance?.amount || "0";
}

async function resolvePairContract(denom: string) {
  const url = `https://dev-api.degenter.io/swap?from=${encodeURIComponent(denom)}&to=uzig`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Pair resolution failed (${response.status})`);
  }
  const body = await response.json();
  const pair =
    body?.data?.pairs?.[0]?.pairContract ||
    body?.data?.pairs?.[0]?.pair_contract ||
    "";
  if (!pair) {
    throw new Error(`No pair was found for ${denom} -> uzig.`);
  }
  return pair;
}

async function executeSwapWithRetry(executeSwap: Function, swapOptions: any) {
  let currentOptions = { ...swapOptions };

  for (let attempt = 1; attempt <= MAX_SEQUENCE_RETRY + MAX_SPREAD_RETRY; attempt += 1) {
    try {
      return await executeSwap(currentOptions);
    } catch (error) {
      if (isSequenceMismatchError(error) && attempt < MAX_SEQUENCE_RETRY) {
        const jitter = Math.floor(Math.random() * 2000) + 500;
        const waitMs = 1500 * attempt + jitter;
        console.warn(`Sequence mismatch; retrying in ${waitMs}ms (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }

      if (isSpreadError(error) && attempt <= MAX_SPREAD_RETRY) {
        const currentBps = currentOptions.slippageBps || 50;
        const nextBps = Math.min(Math.round(currentBps * 1.5), 5000);
        console.warn(`[Spread] Max spread exceeded at ${currentBps} bps; retrying with ${nextBps} bps.`);
        currentOptions = { ...currentOptions, slippageBps: nextBps };
        await sleep(1000);
        continue;
      }

      throw error;
    }
  }
}

function toResultRow(base: any) {
  return {
    walletAddress: base.walletAddress,
    pair: base.pair,
    denom: base.denom,
    soldRawAmount: base.soldRawAmount,
    expectedZigRaw: base.expectedZigRaw,
    expectedZigHuman: base.expectedZigHuman,
    zigDecimals: base.zigDecimals,
    tokenDecimals: base.tokenDecimals,
    txHash: base.txHash || "",
    status: base.status,
    error: base.error || "",
    dryRun: String(Boolean(base.dryRun)),
  };
}

async function writeResultsFile(outPath: string, results: any[]) {
  if (!outPath) return;
  const dir = path.dirname(outPath);
  if (dir && dir !== ".") {
    await mkdir(dir, { recursive: true });
  }

  if (outPath.toLowerCase().endsWith(".csv")) {
    const headers = [
      "walletAddress",
      "pair",
      "denom",
      "soldRawAmount",
      "expectedZigRaw",
      "expectedZigHuman",
      "zigDecimals",
      "tokenDecimals",
      "txHash",
      "status",
      "error",
      "dryRun",
    ];
    const lines = [headers.join(",")];
    for (const result of results.map(toResultRow)) {
      const cells = headers.map((header) => {
        const value = String(result[header] ?? "");
        return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
      });
      lines.push(cells.join(","));
    }
    await writeFile(outPath, lines.join("\n"), "utf8");
    return;
  }

  await writeFile(outPath, JSON.stringify(results.map(toResultRow), null, 2), "utf8");
}

async function main() {
  let options = parseArgs(process.argv.slice(2));

  if (options.help) {
    usage();
    return;
  }

  if (options.interactive || !options.file || !options.denom) {
    options = await promptForOptions(options);
  }

  if (!options.file || !options.denom) {
    usage();
    process.exitCode = 1;
    return;
  }

  const wallets = await readWalletCsv(options.file);

  if (!wallets.length) {
    throw new Error("No wallet rows were loaded from the CSV.");
  }

  const pair = options.pair || (await resolvePairContract(options.denom));
  const pairMeta = await describePair(pair, {
    zigDenom: "uzig",
    tokenDenom: options.denom,
    zigExponent: 6,
    tokenExponent: 0,
  });

  console.log(`Batch seller starting`);
  console.log(`CSV: ${options.file}`);
  console.log(`Token denom: ${options.denom}`);
  console.log(`Pair: ${pair}`);
  console.log(`Slippage: ${formatPercent(options.slippage)}`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log(`Mode: ${options.dryRun ? "dry-run" : "broadcast"}`);
  console.log(`Decimals: token=${pairMeta.tokenExponent}, zig=${pairMeta.zigExponent}`);

  const results: any[] = new Array(wallets.length);
  let cursor = 0;

  async function processWallet(index: number, wallet: any) {
    const prefix = logPrefix(index + 1, wallets.length, wallet.walletAddress);

    try {
      if (!isValidWalletAddress(wallet.walletAddress)) {
        throw new Error("Wallet address must start with zig1 and be exactly 42 characters.");
      }

      const privateKey = normalizePrivateKey(wallet.privateKey);
      const spendable = await fetchSpendableBalance(wallet.walletAddress, options.denom);

      if (BigInt(spendable) === 0n) {
        console.log(`${prefix} skipped: zero spendable ${options.denom} balance`);
        results[index] = {
          walletAddress: wallet.walletAddress,
          pair,
          denom: options.denom,
          soldRawAmount: "0",
          expectedZigRaw: "0",
          expectedZigHuman: 0,
          zigDecimals: pairMeta.zigExponent,
          tokenDecimals: pairMeta.tokenExponent,
          txHash: "",
          status: "skipped",
          error: "",
          dryRun: options.dryRun,
        };
        return;
      }

      const estimate = await estimateSwap({
        pair,
        direction: "token_to_zig",
        amount: spendable,
        slippageBps: Math.round(options.slippage * 100),
        meta: pairMeta,
      });

      const simulation = await simulateSwap(
        pair,
        { type: getAssetType(options.denom), denom: options.denom },
        spendable,
      );
      const expectedZigRaw = String(
        simulation?.returnAmountBase ?? simulation?.returnAmount ?? "0",
      );
      const expectedZigHuman = fromBaseUnits(expectedZigRaw, pairMeta.zigExponent);

      if (
        Number(estimate?.expect?.estHuman || 0) <= 0 ||
        BigInt(expectedZigRaw || "0") === 0n
      ) {
        console.log(`${prefix} skipped: simulation returned zero`);
        results[index] = {
          walletAddress: wallet.walletAddress,
          pair,
          denom: options.denom,
          soldRawAmount: spendable,
          expectedZigRaw,
          expectedZigHuman,
          zigDecimals: pairMeta.zigExponent,
          tokenDecimals: pairMeta.tokenExponent,
          txHash: "",
          status: "skipped",
          error: "Simulation returned zero",
          dryRun: options.dryRun,
        };
        return;
      }

      if (options.dryRun) {
        console.log(
          `${prefix} dry-run: sell=${spendable} ${options.denom}, expect=${expectedZigHuman} uzig_decimals=${pairMeta.zigExponent}`,
        );
        results[index] = {
          walletAddress: wallet.walletAddress,
          pair,
          denom: options.denom,
          soldRawAmount: spendable,
          expectedZigRaw,
          expectedZigHuman,
          zigDecimals: pairMeta.zigExponent,
          tokenDecimals: pairMeta.tokenExponent,
          txHash: "",
          status: "dry-run",
          error: "",
          dryRun: true,
        };
        return;
      }

      const response = await executeSwapWithRetry(executeSwap, {
        pair,
        direction: "token_to_zig",
        amount: spendable,
        privkey: privateKey,
        slippageBps: Math.round(options.slippage * 100),
        meta: pairMeta,
      });

      console.log(
        `${prefix} success: tx=${response.txHash} sold=${spendable} expectedZig=${response.expect?.estHuman} tokenDecimals=${pairMeta.tokenExponent} zigDecimals=${pairMeta.zigExponent}`,
      );

      results[index] = {
        walletAddress: wallet.walletAddress,
        pair,
        denom: options.denom,
        soldRawAmount: spendable,
        expectedZigRaw: response.receivedBase || expectedZigRaw,
        expectedZigHuman: response.expect?.estHuman ?? expectedZigHuman,
        zigDecimals: response.expect?.decimals ?? pairMeta.zigExponent,
        tokenDecimals: pairMeta.tokenExponent,
        txHash: response.txHash || "",
        status: "sold",
        error: "",
        dryRun: false,
      };
    } catch (error) {
      console.error(`${prefix} failed: ${String(error?.message || error)}`);
      results[index] = {
        walletAddress: wallet.walletAddress,
        pair,
        denom: options.denom,
        soldRawAmount: "0",
        expectedZigRaw: "0",
        expectedZigHuman: 0,
        zigDecimals: pairMeta.zigExponent,
        tokenDecimals: pairMeta.tokenExponent,
        txHash: "",
        status: "failed",
        error: String(error?.message || error),
        dryRun: options.dryRun,
      };
    }
  }

  async function workerLoop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= wallets.length) {
        return;
      }
      await processWallet(index, wallets[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, wallets.length) }, () => workerLoop()),
  );

  const sold = results.filter((item) => item?.status === "sold").length;
  const skipped = results.filter((item) => item?.status === "skipped").length;
  const failed = results.filter((item) => item?.status === "failed").length;
  const dryRunCount = results.filter((item) => item?.status === "dry-run").length;

  console.log("");
  console.log("Summary");
  console.log(`Total wallets: ${wallets.length}`);
  console.log(`Sold: ${sold}`);
  console.log(`Dry-run simulated: ${dryRunCount}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (options.out) {
    await writeResultsFile(options.out, results);
    console.log(`Results written to ${options.out}`);
  }
}

main().catch((error) => {
  console.error(`Bulk sell failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
