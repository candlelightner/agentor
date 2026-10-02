import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { attachSettlement, combineSettlements } from './operation-deadline';

/** Existing-file-only recovery read. No key generation, chmod, path-following
 * final symlink, or unbounded read. NONBLOCK prevents a FIFO open waiting before
 * fstat can reject it. The installation controls parent directories. */
export async function readExistingRecoveryKey(
  path: string,
  maximumBytes: number,
  openFile: typeof open = open,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 4096)
    throw new TypeError('Invalid recovery-key read bound');
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let readError: unknown;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes))
      throw new Error('Recovery key must be a bounded regular non-symlink file');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (total > maximumBytes || BigInt(total) !== before.size ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error('Recovery key changed during bounded read');
    return buffer.subarray(0, total).toString('utf8').trim();
  } catch (error) {
    readError = error;
    throw error;
  } finally {
    try {
      await file.close();
    } catch (closeError) {
      if (readError) {
        const combined = combineSettlements(readError, closeError);
        // Deadline errors carry a non-configurable settlement link. Do not
        // replace it on the original error: a failed redefine would discard
        // both lifetimes. Give the combined failure its own writable link.
        const error = new Error(readError instanceof Error ? readError.message : 'Recovery key read failed', { cause: readError });
        attachSettlement(error, combined);
        throw error;
      }
      throw closeError;
    }
  }
}
