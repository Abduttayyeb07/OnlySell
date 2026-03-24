// @ts-nocheck
const LCD_URL = process.env.LCD_URL || "https://zigchain-mainnet-lcd.zigscan.net";
const DEX_API_URL = process.env.DEX_API_URL || "https://dev-api.degenter.io";

const exponentCache = new Map<string, number>();

export async function fetchDenomExponent(denom: string) {
  if (!denom) return null;
  if (exponentCache.has(denom)) {
    return exponentCache.get(denom);
  }

  try {
    const url = `${LCD_URL}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[LCD] denoms_metadata returned ${response.status} for ${denom}`);
      return null;
    }

    const body = await response.json();
    const units = body.metadata?.denom_units;

    if (!Array.isArray(units) || units.length === 0) {
      exponentCache.set(denom, 0);
      return 0;
    }

    const displayUnit = units.find((u: any) => !String(u.denom || "").startsWith("coin."));
    const exponent = displayUnit ? Number(displayUnit.exponent) : 0;
    exponentCache.set(denom, exponent);
    return exponent;
  } catch (error) {
    console.warn(`[LCD] Failed to fetch exponent for ${denom}: ${String(error?.message || error)}`);
    return null;
  }
}

export async function describePair(pair: string, fallbackMeta?: any) {
  let result;

  if (fallbackMeta?.zigDenom && fallbackMeta?.tokenDenom) {
    result = {
      zigDenom: fallbackMeta.zigDenom,
      tokenDenom: fallbackMeta.tokenDenom,
      zigExponent: Number(fallbackMeta.zigExponent ?? 6),
      tokenExponent: Number(fallbackMeta.tokenExponent ?? 6),
    };
  } else {
    if (!pair) {
      throw new Error("Pair address is required to describe the pool.");
    }

    const response = await fetch(`${DEX_API_URL}/tokens`);
    if (!response.ok) {
      throw new Error(`Failed to load tokens list (${response.status}).`);
    }

    const body = await response.json();
    const items = body.data ?? body;
    if (!Array.isArray(items)) {
      throw new Error("Tokens list payload is malformed.");
    }

    const entry = items.find(
      (token: any) =>
        token.pair_contract === pair ||
        token.denom === pair ||
        token.swap_contract === pair ||
        token.contract === pair,
    );

    if (!entry) {
      throw new Error("Pair metadata is missing from token catalog.");
    }

    result = {
      zigDenom: entry.zig_denom ?? entry.zigDenom ?? "uzig",
      tokenDenom: entry.token_denom ?? entry.tokenDenom ?? entry.denom,
      zigExponent: Number(entry.zig_exponent ?? entry.zigExponent ?? 6),
      tokenExponent: Number(entry.token_exponent ?? entry.tokenExponent ?? 6),
    };
  }

  const lcdExponent = await fetchDenomExponent(result.tokenDenom);
  if (lcdExponent !== null) {
    result.tokenExponent = lcdExponent;
  }

  if (result.zigDenom === "uzig" && (result.zigExponent == null || Number.isNaN(result.zigExponent))) {
    result.zigExponent = 6;
  }

  return result;
}
