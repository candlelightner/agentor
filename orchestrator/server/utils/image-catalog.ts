import { join } from 'node:path';
import { ImageCatalogCore } from './image-catalog-core';

export * from './image-catalog-core';

/** Preserve the application API and its lazy service actions. The controlled
 * restore helper imports the same core without application bootstrap code. */
export class ImageCatalogManager extends ImageCatalogCore {
  constructor(dataDir: string, stateWriter?: (state: unknown) => Promise<void>) {
    super(dataDir, stateWriter, () => import('./services'));
  }
}

let singleton: ImageCatalogManager | undefined;
export function useImageCatalogManager() {
  return (singleton ??= new ImageCatalogManager(join(process.env.DATA_DIR || '/data', 'image-catalog')));
}
