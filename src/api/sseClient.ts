import { EventStreamEnvelope } from "./types.js";

export type SseMessageHandler = (event: EventStreamEnvelope) => Promise<void> | void;

export class SseClient {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async connect(onMessage: SseMessageHandler, signal?: AbortSignal, lastEventId?: string) {
    const response = await fetch(this.url, {
      headers: {
        Accept: "text/event-stream",
        ...this.headers,
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const payload = parseSseData(part);
        if (!payload) {
          continue;
        }
        await onMessage(JSON.parse(payload) as EventStreamEnvelope);
      }
    }
  }
}

function parseSseData(block: string): string | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
}
