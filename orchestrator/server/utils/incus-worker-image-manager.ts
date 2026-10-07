import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient, IncusError } from './incus-client';
import { backupInstallationId } from './backup-installation';
import { ImageCatalogManager, type NativeImageContext, type NativeImageBinding } from './image-catalog';
import { IncusImageConverter, incusConversionRecipeId, readCanonicalIncusBootstrap } from './incus-image-converter';
import { normalizeAndImportIncusImage } from './incus-image-artifact';
import { incusImageIdentity } from './incus-worker-image';

/** Backend-only controlled source resolution. Neither portable descriptors,
 * aliases nor an image's own properties create this private authority. Uses
 * existing catalog build locking/acknowledgements, not another job store. */
export class IncusWorkerImageManager {
  constructor(private config: Pick<Config, 'dataDir' | 'incusNetwork' | 'incusStoragePool' | 'incusConverterStoragePool'>,
    private client: IncusClient, private docker: Pick<Docker, 'getImage'>,
    private catalog: ImageCatalogManager, private bootstrapDirectory: string,
    private seedFingerprint: string) {}

  async ensure(requesterId: string, selection: {
    definitionId?: string; version?: string; allowedGroupIds?: Iterable<string>;
  }, validateAuthority: () => Promise<void>, signal?: AbortSignal): Promise<NativeImageBinding> {
    if (!/^[a-f0-9]{64}$/.test(this.seedFingerprint))
      throw new Error('Custom Incus conversion requires an operator-pinned converter seed fingerprint');
    selection = { ...selection, ...(selection.allowedGroupIds ? { allowedGroupIds: [...selection.allowedGroupIds] } : {}) };
    const active = async () => { signal?.throwIfAborted(); await validateAuthority(); signal?.throwIfAborted(); };
    const source = await this.catalog.authorizeNativeImageSource(requesterId, selection, active);
    const files = await readCanonicalIncusBootstrap(this.bootstrapDirectory);
    const context: NativeImageContext = { installationId: await backupInstallationId(this.config.dataDir),
      project: this.client.project, seedFingerprint: this.seedFingerprint, sourceImageId: source.sourceImageId,
      recipeId: incusConversionRecipeId(source.sourceImageId, files), architecture: 'amd64',
      bootstrapGeneration: '3', converterVersion: 'v0.4.0', diskSize: '10G' };
    // Catalog operations recheck their captured exact source under their own
    // mutation chain. This callback checks external owner/group/lifecycle
    // authority only: never reenter the catalog queue from a queued write.
    const current = active;
    const execute = async (buildId: string) => {
      const converter = new IncusImageConverter(this.config, this.client, this.docker, this.bootstrapDirectory);
      const raw = await converter.convert({ jobId: buildId, ownerId: requesterId,
        installationId: context.installationId, sourceImageId: source.sourceImageId,
        seedFingerprint: this.seedFingerprint, validateAuthority: current, signal,
        acknowledge: receipt => this.catalog.acknowledgeNativeConverter(buildId, receipt) });
      if (raw.sourceImageId !== context.sourceImageId || raw.recipeId !== context.recipeId)
        throw new Error('Canonical conversion inputs changed during execution');
      await current();
      const image = await normalizeAndImportIncusImage(this.client, raw,
        join(this.config.dataDir, 'tmp', 'incus-image-' + buildId, 'normalized'), {
          validateAuthority: current,
          acknowledgeImport: acknowledgement => this.catalog.acknowledgeNativeImageImport(buildId, acknowledgement, current),
        }, signal);
      const identity = incusImageIdentity(image);
      if (identity.sourceImageId !== context.sourceImageId || identity.recipeId !== context.recipeId ||
          identity.bootstrapGeneration !== context.bootstrapGeneration || identity.converterVersion !== context.converterVersion)
        throw new Error('Trusted normalized image import does not match conversion inputs');
      await current();
      await this.catalog.publishNativeImageBinding(buildId, identity, 'agentor-storage-ownership-v1', current);
    };
    let binding = await this.catalog.ensureNativeImageBinding(source, context, current, execute);
    // A private cache entry is only a hint. Re-query this exact project and
    // fingerprint; never substitute another image by name/source properties.
    await current();
    let image;
    try { image = await this.client.getImage(binding.identity.fingerprint); }
    catch (error) {
      if (!(error instanceof IncusError) || error.statusCode !== 404) throw error;
      // Native 404 proves absence of this cache artifact, not completion of an
      // operation. Only a previously successful, settled binding is evicted.
      // Reuse existing catalog locking/conversion; attempt regeneration once.
      await this.catalog.forgetMissingNativeImageBinding(source, binding, current, async fingerprint => {
        try { await this.client.getImage(fingerprint); }
        catch (missing) { if (missing instanceof IncusError && missing.statusCode === 404) return; throw missing; }
        throw new Error('Native cache image reappeared before missing-cache eviction');
      });
      binding = await this.catalog.ensureNativeImageBinding(source, context, current, execute);
      await current();
      image = await this.client.getImage(binding.identity.fingerprint);
    }
    const actual = incusImageIdentity(image);
    if (!isDeepStrictEqual(actual, binding.identity)) throw new Error('Native catalog cache image changed or disappeared');
    await current();
    return binding;
  }
}
