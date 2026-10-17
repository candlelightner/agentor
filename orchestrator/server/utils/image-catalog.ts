import { join } from 'node:path';
import { ImageCatalogCore } from './image-catalog-core';
import { IncusImageConverter } from './incus-image-converter';
import { readBackupInstallationId } from './backup-installation';

export * from './image-catalog-core';

/** Preserve the application API and its lazy service actions. The controlled
 * restore helper imports the same core without application bootstrap code. */
export class ImageCatalogManager extends ImageCatalogCore {
  async recoverNativeConverter(id: string, ownerId: string, admin: boolean) {
    return this.withNativeConverterRecovery(id, ownerId, admin, async (receipt, validate, acknowledge) => {
      const { useConfig, useIncusClient } = await import('./services');
      const config = useConfig();
      if (!config.incusEnabled || receipt.installationId !== await readBackupInstallationId(config.dataDir).catch(() => undefined))
        throw Object.assign(new Error('Native converter recovery installation is unavailable'), { statusCode: 409 });
      await IncusImageConverter.cleanup(config, useIncusClient(), receipt, validate, acknowledge);
    });
  }
  constructor(dataDir: string, stateWriter?: (state: unknown) => Promise<void>) {
    super(dataDir, stateWriter, () => import('./services'));
  }
}

let singleton: ImageCatalogManager | undefined;
export function useImageCatalogManager() {
  return (singleton ??= new ImageCatalogManager(join(process.env.DATA_DIR || '/data', 'image-catalog')));
}
