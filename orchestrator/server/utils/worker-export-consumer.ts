import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A consumed tar is not proof that its producer and staging cleanup succeeded.
 * Observe both outcomes immediately and wait for both before the caller may
 * advance a backup job or release its operation. The producer owns actual
 * source/output closure and temporary-file cleanup in `settlement`.
 */
export async function consumeWorkerExport(
  result: { stream: Readable; settlement: Promise<void> },
  openDestination: () => Writable,
  signal?: AbortSignal,
): Promise<void> {
  const producer = result.settlement.catch(error => {
    // A producer failure must also unblock a still-reading consumer. Do not
    // inject an unhandled error before the consumer has attached listeners.
    result.stream.destroy();
    throw error;
  });
  const consumer = Promise.resolve().then(async () => {
    let destination: Writable | undefined;
    let destinationClosed: Promise<void> | undefined;
    try {
      destination = openDestination();
      const owned = destination;
      // pipeline can reject on an error notification before async _destroy
      // closes a file descriptor. Never advance failure cleanup on that alone.
      destinationClosed = new Promise<void>(resolve => {
        const observe = () => {
          if (!owned.closed) return;
          owned.off('close', observe); resolve();
        };
        owned.on('close', observe); observe();
      });
      await pipeline(result.stream, destination, { signal });
    } catch (error) {
      // Also covers synchronous headers/destination setup failures before the
      // pipeline attaches, which otherwise leave an unread bundle alive.
      result.stream.destroy();
      destination?.destroy();
      throw error;
    } finally {
      await destinationClosed;
    }
  });
  const [consumed, settled] = await Promise.allSettled([consumer, producer]);
  if (consumed.status === 'rejected') throw consumed.reason;
  if (settled.status === 'rejected') throw settled.reason;
}
