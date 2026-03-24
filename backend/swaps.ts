// @ts-nocheck
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { Buffer } from "buffer";
import { SigningCosmWasmClient, CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice, coins } from "@cosmjs/stargate";
import { describePair } from "./services/dex.js";
import { fromBaseUnits } from "./lib/amount.js";

const RPC_URL = process.env.RPC_URL || "https://zigchain-mainnet.zigscan.net";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 100);
const PREFIX = process.env.BECH32_PREFIX || "zig";
const DEFAULT_GAS_PRICE = process.env.DEFAULT_GAS_PRICE || "0.025uzig";

function normalizeAssetInfo(asset: any) {
  if (asset.native_token) {
    return { type: "native", denom: asset.native_token.denom };
  }
  if (asset.token) {
    return { type: "cw20", denom: asset.token.contract_addr };
  }
  throw new Error("Unsupported asset info in pair");
}

async function fetchPairAssets(pair: string) {
  const client = await CosmWasmClient.connect(RPC_URL);
  try {
    const response = await client.queryContractSmart(pair, { pair: {} });
    if (!Array.isArray(response.asset_infos)) {
      throw new Error("Pair contract did not expose asset_infos");
    }
    return response.asset_infos.map(normalizeAssetInfo);
  } finally {
    await client.disconnect();
  }
}

function buildAssetInfoPayload(asset: any) {
  return asset.type === "native"
    ? { native_token: { denom: asset.denom } }
    : { token: { contract_addr: asset.denom } };
}

function buildSimulationQuery(asset: any, amount: string) {
  return {
    simulation: {
      offer_asset: {
        amount,
        info: buildAssetInfoPayload(asset),
      },
    },
  };
}

export function computeMaxSpread(
  returnAmount: number,
  spreadAmount: number,
  direction: string,
  receiveDecimals: number,
  customSlippageBps?: number,
) {
  const required = returnAmount > 0 ? spreadAmount / returnAmount : 0;
  const configured = (customSlippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000;
  const isZeroDecimals = receiveDecimals === 0;
  const minSlippage = isZeroDecimals ? 0.05 : 0.005;
  const buffer = direction === "zig_to_token" ? 0.02 : 0.005;
  let effective = Math.max(required + buffer, configured, minSlippage);
  if (effective > 0.5) effective = 0.5;
  return effective;
}

export async function simulateSwap(pair: string, asset: any, amount: string) {
  const client = await CosmWasmClient.connect(RPC_URL);
  try {
    const result = await client.queryContractSmart(pair, buildSimulationQuery(asset, amount));
    const returnAmount = Number(result.return_amount ?? result.returnAmount ?? 0) || 0;
    const spreadAmount = Number(result.spread_amount ?? result.spreadAmount ?? 0) || 0;
    return {
      returnAmount,
      spreadAmount,
      returnAmountBase:
        result.return_amount ??
        result.returnAmount ??
        returnAmount.toString(),
    };
  } finally {
    await client.disconnect();
  }
}

async function buildSwapPayload(options: any, pairMeta: any, direction: string, offerAmount: string) {
  const assets = await fetchPairAssets(options.pair);
  if (assets.length < 2) {
    throw new Error("Pair assets could not be determined.");
  }

  const zigDenom = pairMeta.zigDenom ?? options.meta?.zigDenom ?? "uzig";
  const zigIndex = assets.findIndex((asset: any) => asset.denom === zigDenom);
  const resolvedZigIndex = zigIndex >= 0 ? zigIndex : 0;
  const resolvedTokenIndex = resolvedZigIndex === 0 ? 1 : 0;
  const offerAsset =
    direction === "zig_to_token" ? assets[resolvedZigIndex] : assets[resolvedTokenIndex];
  const receiveAsset =
    direction === "zig_to_token" ? assets[resolvedTokenIndex] : assets[resolvedZigIndex];

  const receiveDecimals =
    direction === "zig_to_token" ? pairMeta.tokenExponent : pairMeta.zigExponent;

  const sim = await simulateSwap(options.pair, offerAsset, offerAmount);
  if (sim.returnAmount <= 0) {
    throw new Error("Simulation returned zero; swap would fail.");
  }

  const maxSpread = computeMaxSpread(
    sim.returnAmount,
    sim.spreadAmount,
    direction,
    receiveDecimals,
    options.slippageBps,
  );

  return {
    sim,
    offerAsset,
    receiveAsset,
    offerDenom: offerAsset.denom,
    receiveDenom: receiveAsset.denom,
    receiveDecimals,
    maxSpread,
  };
}

export async function estimateSwap(options: any) {
  const pairMeta = await describePair(options.pair, options.meta);
  const direction = options.direction === "token_to_zig" ? "token_to_zig" : "zig_to_token";
  const offerAmount = options.amount;
  if (!offerAmount) {
    throw new Error("Offer amount is required for estimation.");
  }

  const payload = await buildSwapPayload(options, pairMeta, direction, offerAmount);
  const estHuman = fromBaseUnits(payload.sim.returnAmountBase, payload.receiveDecimals);
  const minHuman = estHuman * (1 - payload.maxSpread);
  return {
    direction,
    offer: {
      raw: offerAmount,
      denom: payload.offerAsset.denom,
    },
    expect: {
      estHuman,
      minHuman,
      denom: payload.receiveDenom,
      decimals: payload.receiveDecimals,
    },
    spread: {
      maxSpread: payload.maxSpread,
      slippageBps: options.slippageBps,
    },
  };
}

function ensureHexKey(privkey: string) {
  const normalized = privkey.startsWith("0x") ? privkey.slice(2) : privkey;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Private key must be 64 hex characters.");
  }
  return normalized;
}

export async function executeSwap(options: any) {
  const pairMeta = await describePair(options.pair, options.meta);
  const direction = options.direction === "token_to_zig" ? "token_to_zig" : "zig_to_token";
  const offerAmount = options.amount;
  if (!offerAmount) {
    throw new Error("Offer amount is required to execute swap.");
  }

  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(ensureHexKey(options.privkey), "hex"),
    PREFIX,
  );
  const [{ address }] = await wallet.getAccounts();
  const signer = await SigningCosmWasmClient.connectWithSigner(
    RPC_URL,
    wallet,
    { gasPrice: GasPrice.fromString(DEFAULT_GAS_PRICE) },
  );

  const payload = await buildSwapPayload(options, pairMeta, direction, offerAmount);
  const offerAssetInfo = buildAssetInfoPayload(payload.offerAsset);
  const swapMsg: any = {
    swap: {
      offer_asset: {
        amount: offerAmount,
        info: offerAssetInfo,
      },
      max_spread: payload.maxSpread.toFixed(4),
      to: options.recipient || address,
    },
  };

  if (direction === "zig_to_token") {
    swapMsg.swap.ask_asset_info = buildAssetInfoPayload(payload.receiveAsset);
  } else if (options.beliefPrice) {
    swapMsg.swap.belief_price = String(options.beliefPrice);
  }

  const funds =
    payload.offerAsset.type === "native"
      ? coins(offerAmount, payload.offerAsset.denom)
      : undefined;

  const response = await signer.execute(
    address,
    options.contractOverride || options.pair,
    swapMsg,
    "auto",
    options.memo || "bulk seller",
    funds,
  );

  const estHuman = fromBaseUnits(payload.sim.returnAmountBase, payload.receiveDecimals);
  const minHuman = estHuman * (1 - payload.maxSpread);

  return {
    txHash: response.transactionHash,
    offer: {
      raw: offerAmount,
      denom: payload.offerDenom,
    },
    expect: {
      estHuman: Number(estHuman.toFixed(Math.min(6, payload.receiveDecimals))),
      minHuman: Number(minHuman.toFixed(Math.min(6, payload.receiveDecimals))),
      denom: payload.receiveDenom,
      decimals: payload.receiveDecimals,
    },
    receivedBase: payload.sim.returnAmountBase,
  };
}
