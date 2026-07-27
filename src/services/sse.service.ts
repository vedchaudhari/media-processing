/**
 * Minimal Server-Sent Events (SSE) transport for Express.
 *
 * SSE is a plain HTTP GET that never finishes: the server holds the response
 * open and appends `event:`/`data:` frames as things happen. That is all the
 * dashboard needs — one-way server→client push — so there's no WebSocket
 * upgrade, no extra dependency, and the route still runs through the normal
 * middleware chain (requireAuth/requireAdmin work unchanged).
 *
 * This module only owns the *transport*: headers, framing, heartbeats, and
 * cleanup. What gets pushed is up to the caller (see stats-broadcast.service.ts).
 */
import type { Request, Response } from "express";

// How often to emit a comment line to keep the connection warm. Proxies and
// load balancers happily kill an idle connection after 30–60s; a periodic
// no-op frame makes the stream look alive without producing a client event.
const HEARTBEAT_MS = 25_000;

/** A single connected SSE client. Handed back by {@link openSseStream}. */
export interface SseClient {
  /** Sends one named event. `payload` is JSON-serialized. No-op once closed. */
  send(event: string, payload: unknown): void;
  /** Ends the response and stops the heartbeat. Safe to call more than once. */
  close(): void;
  /** True once the client disconnected or `close()` was called. */
  readonly closed: boolean;
}

/**
 * Turns an in-flight request/response pair into an open SSE stream.
 *
 * @param onClose Invoked exactly once when the stream ends — whether the client
 *                navigated away, the network dropped, or `close()` was called.
 *                Use it to deregister the client from whatever is broadcasting.
 */
export const openSseStream = (
  req: Request,
  res: Response,
  onClose?: () => void
): SseClient => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    // `no-transform` matters as much as `no-cache`: some proxies gzip responses
    // and buffer them, which would hold every frame back until the stream ends.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx-specific opt-out of response buffering, harmless elsewhere.
    "X-Accel-Buffering": "no",
  });
  // Push the headers out now so the browser's fetch resolves immediately
  // instead of waiting for the first frame.
  res.flushHeaders();

  // Node closes idle sockets by default (server.requestTimeout / socket
  // timeout); an SSE stream is idle by design between events, so opt out.
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
      // `data:` may not contain raw newlines — a multi-line payload is sent as
      // one `data:` line per line, and the client rejoins them with "\n".
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

  // A line starting with ":" is an SSE comment: it keeps the socket busy but
  // never surfaces as an event on the client.
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: ping\n\n`);
  }, HEARTBEAT_MS);
  // Never let the heartbeat hold the process open during shutdown.
  heartbeat.unref();

  // The client hanging up is the common case — treat it exactly like close().
  res.on("close", () => client.close());

  return client;
};
