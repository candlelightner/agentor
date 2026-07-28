// Ambient declaration augmenting `@types/archiver`, which omits the package's
// callable default (`archiver(format, options)`) and its `create` export. The
// runtime module (archiver@7) exports a vending function that is both callable
// and carries a `.create` method; this declaration merges the missing members
// onto the existing type definitions so `import archiver from 'archiver'`
// type-checks while keeping the rich `Archiver`/`EntryData` interfaces from
// `@types/archiver`.
import type { Archiver, ArchiverOptions } from 'archiver';

declare module 'archiver' {
  /** Vending function: create a new `Archiver` instance for the given format. */
  function archiver(format: 'zip' | 'tar' | 'json', options?: ArchiverOptions): Archiver;
  namespace archiver {
    export function create(format: 'zip' | 'tar' | 'json', options?: ArchiverOptions): Archiver;
    export { Archiver, ArchiverOptions };
  }
  export default archiver;
}