import { readCdx, redactUrl } from "./lib/wacz";
import { PRIVATE_WACZ_INDEX, requirePrivateCapture } from "./lib/private-paths";

requirePrivateCapture();

const indexPath = PRIVATE_WACZ_INDEX;
const records = await readCdx(indexPath);

function aggregateBy(key: (record: (typeof records)[number]) => string) {
  const result = new Map<string, { count: number; compressedBytes: number }>();
  for (const record of records) {
    const name = key(record);
    const current = result.get(name) ?? { count: 0, compressedBytes: 0 };
    current.count += 1;
    current.compressedBytes += record.length;
    result.set(name, current);
  }
  return [...result.entries()].sort(
    (left, right) => right[1].compressedBytes - left[1].compressedBytes,
  );
}

console.log({
  records: records.length,
  uniqueUrls: new Set(records.map((record) => record.url)).size,
});

console.log("\nMIME types");
console.table(
  aggregateBy((record) => record.mime || "(none)").map(([mime, value]) => ({
    mime,
    count: value.count,
    compressedMiB: (value.compressedBytes / 1024 / 1024).toFixed(2),
  })),
);

console.log("\nHosts");
console.table(
  aggregateBy((record) => {
    try {
      return new URL(record.url).host || "(empty)";
    } catch {
      return "(invalid URL)";
    }
  }).map(([host, value]) => ({
    host,
    count: value.count,
    compressedMiB: (value.compressedBytes / 1024 / 1024).toFixed(2),
  })),
);

console.log("\nLargest records");
console.table(
  records
    .toSorted((left, right) => right.length - left.length)
    .slice(0, 40)
    .map((record) => ({
      compressedMiB: (record.length / 1024 / 1024).toFixed(2),
      mime: record.mime,
      status: record.status,
      timestamp: record.timestamp,
      url: redactUrl(record.url).slice(0, 220),
    })),
);
