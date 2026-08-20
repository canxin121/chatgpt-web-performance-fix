import { readCdx, readWarcResponse } from "../analysis/lib/wacz";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE } from "../analysis/lib/private-paths";
import type {
  ConversationNode,
  ConversationPayload,
} from "../src/optimizer";

export interface CapturedConversation {
  payload: ConversationPayload;
  text: string;
}

let cached: Promise<CapturedConversation> | undefined;

export function loadCapturedConversation(): Promise<CapturedConversation> {
  cached ??= (async () => {
    const records = await readCdx(PRIVATE_WACZ_INDEX);
    const record = records.find((candidate) => {
      if (candidate.mime !== "application/json") return false;
      return /\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(
        new URL(candidate.url).pathname,
      );
    });

    if (!record) throw new Error("Captured legacy conversation response not found");

    const response = readWarcResponse(
      PRIVATE_WARC_ARCHIVE,
      record,
    );
    const text = response.body.toString("utf8");
    return {
      payload: JSON.parse(text) as ConversationPayload,
      text,
    };
  })();

  return cached;
}

export function traceActivePath(
  payload: ConversationPayload,
): Array<{ id: string; node: ConversationNode }> {
  const mapping = payload.mapping;
  if (!mapping || typeof payload.current_node !== "string") {
    throw new Error("Conversation payload has no mapping/current node");
  }

  const reversePath: Array<{ id: string; node: ConversationNode }> = [];
  const seen = new Set<string>();
  let id: string | null | undefined = payload.current_node;

  while (id != null) {
    if (seen.has(id)) throw new Error(`Cycle at ${id}`);
    seen.add(id);
    const node = mapping[id];
    if (!node) throw new Error(`Missing node ${id}`);
    reversePath.push({ id, node });
    id = node.parent;
  }

  return reversePath.reverse();
}
