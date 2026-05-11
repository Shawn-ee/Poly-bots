import { EventStreamEnvelope } from "./types.js";

export type SseMessageHandler<TEvent extends EventStreamEnvelope = EventStreamEnvelope> = (
  event: TEvent,
  meta: { id: string | null; event: string | null },
) => Promise<void> | void;

export type SseStatusHandler = (status: {
  phase: "connecting" | "connected" | "disconnected" | "reconnecting" | "error";
  lastEventId: string | null;
  attempt: number;
  error?: Error;
}) => Promise<void> | void;

export class SseClient {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async connect<TEvent extends EventStreamEnvelope = EventStreamEnvelope>(
    onMessage: SseMessageHandler<TEvent>,
    signal?: AbortSignal,
    lastEventId?: string,
  ) {
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
        const parsed = parseSseBlock(part);
        if (!parsed.data) {
          continue;
        }
        await onMessage(JSON.parse(parsed.data) as TEvent, {
          id: parsed.id,
          event: parsed.event,
        });
      }
    }
  }

  async stream<TEvent extends EventStreamEnvelope = EventStreamEnvelope>(params: {
    onMessage: SseMessageHandler<TEvent>;
    onStatus?: SseStatusHandler;
    signal?: AbortSignal;
    lastEventId?: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  }) {
    let currentLastEventId = params.lastEventId ?? null;
    let attempt = 0;

    while (!params.signal?.aborted) {
      try {
        await params.onStatus?.({
          phase: attempt === 0 ? "connecting" : "reconnecting",
          lastEventId: currentLastEventId,
          attempt,
        });

        let connectedNotified = false;
        await this.connect<TEvent>(
          async (event, meta) => {
            currentLastEventId = event.id ?? event.sequence ?? meta.id ?? currentLastEventId;
            if (!connectedNotified) {
              connectedNotified = true;
              attempt = 0;
              await params.onStatus?.({
                phase: "connected",
                lastEventId: currentLastEventId,
                attempt,
              });
            }
            await params.onMessage(event, meta);
          },
          params.signal,
          currentLastEventId ?? undefined,
        );

        if (params.signal?.aborted) {
          break;
        }

        await params.onStatus?.({
          phase: "disconnected",
          lastEventId: currentLastEventId,
          attempt,
        });
      } catch (error) {
        if (params.signal?.aborted) {
          break;
        }
        await params.onStatus?.({
          phase: "error",
          lastEventId: currentLastEventId,
          attempt,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }

      if (params.signal?.aborted) {
        break;
      }

      attempt += 1;
      const reconnectBaseMs = params.reconnectBaseMs ?? 1_000;
      const reconnectMaxMs = params.reconnectMaxMs ?? 15_000;
      const delayMs = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(attempt - 1, 4));
      await sleep(delayMs, params.signal).catch(() => undefined);
    }
  }
}

function parseSseBlock(block: string): { id: string | null; event: string | null; data: string | null } {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trimStart();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    id,
    event,
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
