import { serverLogDownload } from '../../utils/server-log-download';

/** Authenticated, server-only JSONL export. Same bounded filters/cursor as
 * logs.server-read; response headers report continuation and truncation. */
export default serverLogDownload;
