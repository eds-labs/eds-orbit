/** A received server-sent event with the time it arrived. */
export type ReceivedEvent = {
  id: number | null;
  event: string;
  data: unknown;
  at: number;
};

/**
 * A minimal SSE client for tests: reads one HTTP stream until the server
 * ends it or `close()` is called. Unlike EventSource it never reconnects on
 * its own, so tests drive reconnects with `Last-Event-ID` explicitly.
 */
export function openStream(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const events: ReceivedEvent[] = [];
  const waiters: Array<() => void> = [];
  let status = 0;
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const ended = (async () => {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
      });
      status = response.status;
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let id: number | null = null;
          let event = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = Number(line.slice(4));
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (!data.length) continue;
          events.push({
            id,
            event,
            data: JSON.parse(data.join("\n")),
            at: performance.now(),
          });
          notify();
        }
      }
    } catch {
      // Aborted by the test or cut by the server.
    } finally {
      notify();
    }
  })();
  let finished = false;
  void ended.then(() => (finished = true));
  return {
    events,
    get status() {
      return status;
    },
    get finished() {
      return finished;
    },
    ended,
    /** Resolves once `predicate` holds for the received events or the stream ended. */
    async until(
      predicate: (events: ReceivedEvent[]) => boolean,
      timeoutMs = 10000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        if (finished) return false;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return true;
    },
    close() {
      controller.abort();
      return ended;
    },
  };
}

export function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? NaN;
}
