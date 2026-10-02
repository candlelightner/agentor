import { createError, send, sendError, toNodeListener, type App, type H3Event } from 'h3';
import type { InstanceControlPlaneCoordinator } from './instance-control-plane-coordinator';

const installed = new WeakSet<App>();

/** Create detached work IN its admitted child context, before returning the
 * response. Promise-form waitUntil can retain lifetime accounting but cannot
 * retroactively move an existing promise's continuations into that context.
 * All write-capable detached work must use an unstarted thunk here (or fork).
 */
export function scheduleInstanceHttpTask<T>(
  event: H3Event,
  coordinator: InstanceControlPlaneCoordinator,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (typeof operation !== 'function') throw new TypeError('Instance HTTP task requires an unstarted thunk');
  const child = coordinator.fork();
  const actual = child.run(operation);
  // Observe failure even when registration itself throws. Neither case cancels
  // actual work or retires the child before its awaited cleanup has settled.
  void actual.catch(() => {});
  event.waitUntil(actual);
  return actual;
}

/** Enroll the actual node-server request lifetime, including H3's error path.
 * Wrapping only app.handler is insufficient: toNodeListener handles errors and
 * invokes response hooks AFTER that handler rejects. The inner listener here
 * owns that complete path; the outer listener has only a non-writing rejection
 * renderer. The original handler/options retain all normal H3/Nitro semantics.
 *
 * This adapter targets the pinned node-server preset, not toWebHandler. It does
 * not cover WebSocket upgrade hooks, detached tasks that omit waitUntil/fork,
 * or hidden asynchronous stream cleanup; those require their own adapters.
 * A deadline-wrapped operation must separately lease its actual underlying work.
 */
export function installInstanceHttpAdapter(app: App, coordinator: InstanceControlPlaneCoordinator,
  barrierControl?: (event: H3Event) => unknown): void {
  if (installed.has(app)) throw new Error('Instance HTTP lifetime adapter already installed');
  installed.add(app);
  const originalOptions = app.options;
  const originalOnRequest = originalOptions.onRequest;
  originalOptions.onRequest = async event => {
    // Nitro assigns waitUntil during onRequest. Intercept replacement as well
    // as subsequent calls, so request hooks cannot start unaccounted work.
    let delegate = event.waitUntil;
    const tracked = (promise: Promise<unknown>) => {
      // Accounting only for an already-created promise. Use the thunk helper
      // above when a continuation needs nested writer admission after response.
      const child = coordinator.fork();
      void child.run(() => promise).catch(() => {});
      return delegate?.call(event, promise);
    };
    Object.defineProperty(event, 'waitUntil', {
      configurable: true,
      get: () => tracked,
      set: value => { delegate = value; },
    });
    await originalOnRequest?.(event);
  };
  // The H3 handler closes over originalOptions. Leave those hooks intact for
  // the inner listener and redirect only the outer listener's error handling.
  const originalHandler = app.handler;
  const inner: App = { ...app, options: originalOptions, handler: originalHandler };
  const listener = toNodeListener(inner);
  app.options = {
    debug: false,
    onError: async (error, event) => { await sendError(event, createError(error), false); },
  };
  const wrapped = Object.assign(async (outerEvent: H3Event) => {
    if (!coordinator.mutationAllowed && barrierControl) {
      outerEvent.node.res.setHeader('Cache-Control', 'no-store');
      outerEvent.node.res.setHeader('X-Content-Type-Options', 'nosniff');
      const body = barrierControl(outerEvent);
      outerEvent.node.res.setHeader('Content-Type', 'application/json');
      return send(outerEvent, JSON.stringify(body));
    }
    await coordinator.run(async () => {
      // The node-server event has not run any app hooks yet. H3 creates the
      // authoritative inner event using the SAME request/response; Nitro then
      // initializes platform context, auth and waitUntil exactly once.
      await listener(outerEvent.node.req, outerEvent.node.res);
    });
  }, originalHandler);
  app.handler = wrapped;
}
