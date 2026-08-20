import { mkdirSync } from "node:fs";
import { optimizeConversationPayload, type ConversationPayload } from "../src/optimizer";
import { loadCapturedConversation, traceActivePath } from "../tests/helpers";
import { hasPrivateCapture } from "../analysis/lib/private-paths";

if (!hasPrivateCapture()) {
  console.log("Skipping capture benchmark: .private capture data is not available.");
  process.exit(0);
}

interface Distribution {
  minMs: number;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

function summarize(samples: number[]): Distribution {
  const sorted = samples.toSorted((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    minMs: sorted[0] ?? 0,
    medianMs: at(0.5),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: at(0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function benchmark<T>(iterations: number, operation: () => T): Distribution {
  for (let index = 0; index < 3; index += 1) operation();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function simulateClientHydration(payload: ConversationPayload): number {
  const nodes = Object.values(payload.mapping ?? {}).map((node) => ({
    id: node.id,
    parentId: node.parent,
    childrenIds: [...(node.children ?? [])],
    message: node.message
      ? {
          ...node.message,
          metadata: { ...(node.message.metadata ?? {}) },
          clientMetadata: {},
        }
      : null,
  }));

  // Prevent the benchmark from being optimized away and approximate the later
  // branch/grouping work performed by the captured ChatGPT bundle.
  const path = traceActivePath(payload);
  let turns = 0;
  let contentCharacters = 0;
  for (const { node } of path) {
    const message = node.message;
    if (message?.author?.role === "user") turns += 1;
    const parts = message?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        contentCharacters +=
          typeof part === "string" ? part.length : JSON.stringify(part).length;
      }
    }
  }
  return nodes.length + path.length + turns + contentCharacters;
}

const { payload: originalPayload, text: originalText } =
  await loadCapturedConversation();
const optimization = optimizeConversationPayload(originalPayload, {
  recentFullTurns: 1,
});
const optimizedPayload = optimization.payload;
const optimizedText = JSON.stringify(optimizedPayload);

const iterations = 30;
const report = {
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    iterations,
  },
  capture: {
    originalBytes: Buffer.byteLength(originalText),
    optimizedBytes: Buffer.byteLength(optimizedText),
    byteReductionPercent:
      (1 - Buffer.byteLength(optimizedText) / Buffer.byteLength(originalText)) * 100,
    ...optimization.stats,
  },
  timings: {
    parseOriginal: benchmark(iterations, () => JSON.parse(originalText)),
    parseOptimized: benchmark(iterations, () => JSON.parse(optimizedText)),
    hydrateOriginal: benchmark(iterations, () =>
      simulateClientHydration(originalPayload),
    ),
    hydrateOptimized: benchmark(iterations, () =>
      simulateClientHydration(optimizedPayload),
    ),
    optimizeAndStringify: benchmark(iterations, () => {
      const cloned = JSON.parse(originalText) as ConversationPayload;
      return JSON.stringify(
        optimizeConversationPayload(cloned, { recentFullTurns: 1 }).payload,
      );
    }),
  },
};

mkdirSync("analysis/output", { recursive: true });
await Bun.write("analysis/output/benchmark.json", `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
