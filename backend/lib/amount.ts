// @ts-nocheck
export function fromBaseUnits(value: string | number | bigint, decimals: number) {
  const amount = BigInt(value ?? "0");
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  const fracString =
    frac === 0n
      ? ""
      : `.${frac.toString().padStart(decimals, "0")}`.replace(/0+$/, "");
  return Number(`${whole}${fracString}`);
}
