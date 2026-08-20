import { existsSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_ROOT = process.env.CHATGPT_PERF_PRIVATE_DIR ?? ".private";
export const PRIVATE_CAPTURE_DIR = join(PRIVATE_ROOT, "captures");
export const PRIVATE_WACZ_DIR = join(PRIVATE_ROOT, "wacz");
export const PRIVATE_WACZ_INDEX = join(PRIVATE_WACZ_DIR, "indexes", "index.cdx");
export const PRIVATE_WARC_ARCHIVE = join(PRIVATE_WACZ_DIR, "archive", "data.warc.gz");
export const PRIVATE_EXTRACTED_DIR = join(PRIVATE_ROOT, "extracted");

export function hasPrivateCapture(): boolean {
  return existsSync(PRIVATE_WACZ_INDEX) && existsSync(PRIVATE_WARC_ARCHIVE);
}

export function requirePrivateCapture(): void {
  if (!hasPrivateCapture()) {
    throw new Error(
      "Private capture data is not available. Put local WACZ extraction data under .private/ or set CHATGPT_PERF_PRIVATE_DIR.",
    );
  }
}
