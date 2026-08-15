import type { Request, Response } from "express";

const HEARTBEAT_MS = 25_000;

export interface SseClient {

  send(event: string, payload: unknown): void;

  close(): void;

  readonly closed: boolean;
}

export const openSseStream = (
  req: Request,
  res: Response,
  onClose?: () => void
): SseClient => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",

    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",

    "X-Accel-Buffering": "no",
  });

  res.flushHeaders();

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  let closed = false;

  const client: SseClient = {
    get closed() {
      return closed;
    },

    send(event: string, payload: unknown) {
      if (closed) return;

      const body = JSON.stringify(payload) ?? "null";
      const lines = body
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n");
      res.write(`event: ${event}\n${lines}\n\n`);
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.end();
      onClose?.();
    },
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: ping\n\n`);
  }, HEARTBEAT_MS);

  heartbeat.unref();

  res.on("close", () => client.close());

  return client;
};
