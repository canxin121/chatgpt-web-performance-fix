import { readCdx, readWarcResponse } from "./lib/wacz";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE, requirePrivateCapture } from "./lib/private-paths";

requirePrivateCapture();

interface ConversationNode {
  id: string;
  parent: string | null;
  children: string[];
  message?: {
    id: string;
    author?: { role?: string; name?: string };
    recipient?: string;
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    metadata?: Record<string, unknown>;
  } | null;
}

interface Conversation {
  title?: string;
  current_node: string;
  mapping: Record<string, ConversationNode>;
}

const records = await readCdx(PRIVATE_WACZ_INDEX);
const conversationRecords = records.filter(
  (record) =>
    record.mime === "application/json" &&
    /\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(
      new URL(record.url).pathname,
    ),
);

if (conversationRecords.length === 0) {
  throw new Error("No conversation response found in WACZ index");
}

const archivePath = PRIVATE_WARC_ARCHIVE;

for (const record of conversationRecords) {
  const response = readWarcResponse(archivePath, record);
  const conversation = JSON.parse(response.body.toString("utf8")) as Conversation;
  const mapping = conversation.mapping;
  const path: ConversationNode[] = [];
  const seen = new Set<string>();
  let id: string | null = conversation.current_node;

  while (id && !seen.has(id)) {
    seen.add(id);
    const node: ConversationNode | undefined = mapping[id];
    if (!node) break;
    path.push(node);
    id = node.parent;
  }
  path.reverse();

  const combinations = new Map<
    string,
    { count: number; serializedBytes: number; contentChars: number }
  >();

  for (const node of path) {
    const message = node.message;
    if (!message) continue;
    const role = message.author?.role ?? "unknown";
    const contentType = message.content?.content_type ?? "unknown";
    const key = `${role}/${contentType}`;
    const current = combinations.get(key) ?? {
      count: 0,
      serializedBytes: 0,
      contentChars: 0,
    };
    current.count += 1;
    current.serializedBytes += Buffer.byteLength(JSON.stringify(message));

    for (const part of message.content?.parts ?? []) {
      current.contentChars +=
        typeof part === "string" ? part.length : JSON.stringify(part).length;
    }
    if (typeof message.content?.text === "string") {
      current.contentChars += message.content.text.length;
    }
    combinations.set(key, current);
  }

  console.log("\nConversation snapshot", {
    timestamp: record.timestamp,
    title: conversation.title,
    compressedBytes: record.length,
    responseBytes: response.body.length,
    mappingNodes: Object.keys(mapping).length,
    activePathNodes: path.length,
    offPathNodes: Object.keys(mapping).length - path.length,
  });
  console.table(
    [...combinations.entries()]
      .toSorted((left, right) => right[1].serializedBytes - left[1].serializedBytes)
      .map(([kind, value]) => ({ kind, ...value })),
  );
}
