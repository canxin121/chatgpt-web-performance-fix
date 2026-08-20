import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readCdx, readWarcResponse } from "./lib/wacz";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE, requirePrivateCapture } from "./lib/private-paths";

requirePrivateCapture();

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const records = (await readCdx(PRIVATE_WACZ_INDEX)).filter(
  (record) =>
    record.mime === "application/json" &&
    /\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(
      new URL(record.url).pathname,
    ),
);

const requests = records.map((record) => {
  const response = readWarcResponse(PRIVATE_WARC_ARCHIVE, record);
  const payload = JSON.parse(response.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  const safeUrls = Array.isArray(payload.safe_urls) ? payload.safe_urls : [];
  const blockedUrls = Array.isArray(payload.blocked_urls) ? payload.blocked_urls : [];
  const {
    safe_urls: _safeUrls,
    blocked_urls: _blockedUrls,
    ...stablePayload
  } = payload;

  return {
    timestamp: record.timestamp,
    pageId: response.warcHeaders.get("warc-page-id") ?? "unknown",
    compressedBytes: record.length,
    bodyBytes: response.body.length,
    mappingNodes:
      payload.mapping && typeof payload.mapping === "object"
        ? Object.keys(payload.mapping).length
        : 0,
    mappingSha256: digest(payload.mapping),
    stablePayloadSha256: digest(stablePayload),
    safeUrlCount: safeUrls.length,
    safeUrlSetSha256: digest([...safeUrls].sort()),
    blockedUrlCount: blockedUrls.length,
    blockedUrlSetSha256: digest([...blockedUrls].sort()),
  };
});

const byPage = Object.groupBy(requests, (request) => request.pageId);
const compressedBytes = requests.map((request) => request.compressedBytes);
const report = {
  requestCount: requests.length,
  pageCaptureCount: Object.keys(byPage).length,
  requestsPerPageCounts: Object.values(byPage)
    .map((pageRequests) => pageRequests?.length ?? 0)
    .sort((left, right) => left - right),
  mappingIdentical:
    new Set(requests.map((request) => request.mappingSha256)).size === 1,
  stablePayloadIdentical:
    new Set(requests.map((request) => request.stablePayloadSha256)).size === 1,
  safeUrlSetIdentical:
    new Set(requests.map((request) => request.safeUrlSetSha256)).size === 1,
  blockedUrlSetIdentical:
    new Set(requests.map((request) => request.blockedUrlSetSha256)).size === 1,
  bodyBytes: [...new Set(requests.map((request) => request.bodyBytes))],
  mappingNodes: [...new Set(requests.map((request) => request.mappingNodes))],
  safeUrlCounts: [...new Set(requests.map((request) => request.safeUrlCount))],
  blockedUrlCounts: [...new Set(requests.map((request) => request.blockedUrlCount))],
  compressedBytesRange:
    compressedBytes.length === 0
      ? null
      : { min: Math.min(...compressedBytes), max: Math.max(...compressedBytes) },
};

mkdirSync("analysis/output", { recursive: true });
await Bun.write(
  "analysis/output/duplicate-requests.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
