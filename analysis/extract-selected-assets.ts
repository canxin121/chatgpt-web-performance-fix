import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { readCdx, readWarcResponse } from "./lib/wacz";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE, PRIVATE_EXTRACTED_DIR, requirePrivateCapture } from "./lib/private-paths";

requirePrivateCapture();

const records = await readCdx(PRIVATE_WACZ_INDEX);
const archivePath = PRIVATE_WARC_ARCHIVE;
const outputDirectory = PRIVATE_EXTRACTED_DIR;
mkdirSync(outputDirectory, { recursive: true });

const selected = records.filter((record) => {
  if (record.mime === "text/html") return true;
  if (record.mime !== "application/javascript") return false;
  return (
    /\/conversation-small-[^/]+\.js$/.test(new URL(record.url).pathname) ||
    /\/assets\/(?:04a8820c|8b34dbc2|d8c9beb7)-[^/]+\.js$/.test(
      new URL(record.url).pathname,
    )
  );
});

for (const record of selected) {
  const response = readWarcResponse(archivePath, record);
  const pathname = new URL(record.url).pathname;
  const extension = record.mime === "text/html" ? ".html" : "";
  const filename = `${record.timestamp}-${basename(pathname) || "document"}${extension}`;
  const outputPath = `${outputDirectory}/${filename}`;
  writeFileSync(outputPath, response.body);
  console.log(
    JSON.stringify({
      timestamp: record.timestamp,
      mime: record.mime,
      bytes: response.body.length,
      outputPath,
      url: record.url,
    }),
  );
}
