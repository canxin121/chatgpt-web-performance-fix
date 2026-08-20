import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export interface CdxRecord {
  surt: string;
  timestamp: string;
  url: string;
  digest?: string;
  mime?: string;
  offset: number;
  length: number;
  recordDigest?: string;
  status?: number;
  filename?: string;
  requestBody?: string;
  method?: string;
}

export interface ParsedWarcResponse {
  warcHeaders: Map<string, string>;
  httpStatusLine: string;
  httpHeaders: Map<string, string>;
  body: Buffer;
}

function parseHeaderBlock(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return headers;
}

export async function readCdx(path: string): Promise<CdxRecord[]> {
  const text = await Bun.file(path).text();
  const records: CdxRecord[] = [];

  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const firstSpace = line.indexOf(" ");
    const secondSpace = line.indexOf(" ", firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) {
      throw new Error(`Malformed CDX line: ${line.slice(0, 120)}`);
    }

    records.push({
      surt: line.slice(0, firstSpace),
      timestamp: line.slice(firstSpace + 1, secondSpace),
      ...JSON.parse(line.slice(secondSpace + 1)),
    });
  }

  return records;
}

export function readWarcResponse(
  archivePath: string,
  record: Pick<CdxRecord, "offset" | "length">,
): ParsedWarcResponse {
  const archive = readFileSync(archivePath);
  const compressed = archive.subarray(record.offset, record.offset + record.length);
  const decompressed = gunzipSync(compressed);
  const delimiter = Buffer.from("\r\n\r\n");
  const warcEnd = decompressed.indexOf(delimiter);
  const httpEnd = decompressed.indexOf(delimiter, warcEnd + delimiter.length);

  if (warcEnd < 0 || httpEnd < 0) {
    throw new Error(
      `Could not locate WARC/HTTP header boundaries at offset ${record.offset}`,
    );
  }

  const warcBlock = decompressed.subarray(0, warcEnd).toString("utf8");
  const httpBlock = decompressed
    .subarray(warcEnd + delimiter.length, httpEnd)
    .toString("utf8");

  return {
    warcHeaders: parseHeaderBlock(warcBlock),
    httpStatusLine: httpBlock.split(/\r?\n/, 1)[0] ?? "",
    httpHeaders: parseHeaderBlock(httpBlock),
    body: decompressed.subarray(httpEnd + delimiter.length).subarray(0, Number(
      parseHeaderBlock(httpBlock).get("content-length") ?? Number.MAX_SAFE_INTEGER,
    )),
  };
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of ["prepare_token", "proofofwork", "turnstile"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
