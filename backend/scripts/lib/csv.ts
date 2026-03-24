// @ts-nocheck
import { readFile } from "node:fs/promises";

const ADDRESS_HEADERS = new Set(["walletaddress", "address"]);
const PRIVATE_KEY_HEADERS = new Set(["privatekey", "privkey"]);

export type WalletRecord = {
  walletAddress: string;
  privateKey: string;
  lineNumber: number;
};

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function resolveColumnIndexes(rows: string[]) {
  const headerCells = splitCsvLine(rows[0]).map((cell) => cell.toLowerCase());
  const hasHeader = headerCells.some(
    (cell) => ADDRESS_HEADERS.has(cell) || PRIVATE_KEY_HEADERS.has(cell),
  );

  if (!hasHeader) {
    return { walletIndex: 0, privateKeyIndex: 1, startIndex: 0 };
  }

  const walletIndex = headerCells.findIndex((cell) => ADDRESS_HEADERS.has(cell));
  const privateKeyIndex = headerCells.findIndex((cell) => PRIVATE_KEY_HEADERS.has(cell));

  if (walletIndex === -1 || privateKeyIndex === -1) {
    throw new Error("CSV must include walletAddress/address and privateKey/privkey columns.");
  }

  return { walletIndex, privateKeyIndex, startIndex: 1 };
}

export async function readWalletCsv(filePath: string): Promise<WalletRecord[]> {
  const text = await readFile(filePath, "utf8");
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (!rows.length) {
    throw new Error("CSV file is empty.");
  }

  const { walletIndex, privateKeyIndex, startIndex } = resolveColumnIndexes(rows);
  const wallets: WalletRecord[] = [];

  for (let i = startIndex; i < rows.length; i += 1) {
    const cells = splitCsvLine(rows[i]);
    const walletAddress = cells[walletIndex] || cells[0] || "";
    const privateKey = cells[privateKeyIndex] || cells[1] || "";

    if (!walletAddress || !privateKey) {
      continue;
    }

    wallets.push({
      walletAddress: walletAddress.trim(),
      privateKey: privateKey.trim(),
      lineNumber: i + 1,
    });
  }

  return wallets;
}
