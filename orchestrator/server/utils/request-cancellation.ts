import type { H3Event } from "h3";

/** Bridge an HTTP disconnect into the underlying Docker/archive work before a
 * response stream exists. Listening only after `download()` returns misses
 * cancellations during path probes and helper startup. */
export function requestCancellation(event: H3Event): {
  signal: AbortSignal;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted)
      controller.abort(new Error("Client disconnected"));
  };
  const onResponseClose = () => {
    if (!event.node.res.writableEnded) abort();
  };
  event.node.req.once("aborted", abort);
  event.node.res.once("close", onResponseClose);
  return {
    signal: controller.signal,
    detach: () => {
      event.node.req.off("aborted", abort);
      event.node.res.off("close", onResponseClose);
    },
  };
}
