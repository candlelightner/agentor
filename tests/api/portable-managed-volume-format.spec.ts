import { expect, test } from "@playwright/test";
import {
  MANAGED_VOLUMES_BUNDLE_MEMBER,
  MAX_PORTABLE_MANAGED_VOLUMES,
  PORTABLE_MANAGED_VOLUME_ROOT,
  parsePortableManagedVolumeEntries,
  portableManagedVolumeArchiveName,
  resolvePortableManagedVolumeFormat,
} from "../../orchestrator/server/utils/portable-managed-volume-format";

const entry = (index = 0) => ({
  target: `/srv/data-${index}`,
  name: `data ${index}`,
  archive: `volumes/${index}.tar`,
});

test("portable format constants and exact v6 agreement are stable", () => {
  expect(MANAGED_VOLUMES_BUNDLE_MEMBER).toBe("managed-volumes.tar.gz");
  expect(PORTABLE_MANAGED_VOLUME_ROOT).toBe("volume/");
  expect(MAX_PORTABLE_MANAGED_VOLUMES).toBe(32);
  expect(portableManagedVolumeArchiveName(31)).toBe("volumes/31.tar");
  expect(() => portableManagedVolumeArchiveName(32)).toThrow(/index/i);

  expect(resolvePortableManagedVolumeFormat({
    version: 6,
    contentsManagedVolumes: true,
    managedVolumes: [],
    payloadPresent: true,
  })).toEqual([]);
  expect(resolvePortableManagedVolumeFormat({
    version: 6,
    contentsManagedVolumes: true,
    managedVolumes: [entry()],
    payloadPresent: true,
  })).toEqual([entry()]);
});

test("legacy formats reject every portable field and never treat coverage as mounts", () => {
  for (let version = 1; version <= 5; version += 1) {
    const input = {
      version,
      contentsManagedVolumes: undefined,
      managedVolumes: undefined,
      localPersistence: [{ path: "/host/claim", included: true }],
      payloadPresent: false,
    };
    expect(resolvePortableManagedVolumeFormat(input)).toEqual([]);
    expect(input.managedVolumes).toBeUndefined();
    for (const mutation of [
      { contentsManagedVolumes: false },
      { managedVolumes: [] },
      { payloadPresent: true },
    ]) expect(() => resolvePortableManagedVolumeFormat({ ...input, ...mutation })).toThrow(/version 6/i);
  }
});

test("v6 rejects missing, false, or partial manifest/member agreement", () => {
  const base = { version: 6, contentsManagedVolumes: true, managedVolumes: [entry()], payloadPresent: true };
  for (const mutation of [
    { contentsManagedVolumes: false },
    { contentsManagedVolumes: undefined },
    { managedVolumes: undefined },
    { payloadPresent: false },
  ]) expect(() => resolvePortableManagedVolumeFormat({ ...base, ...mutation })).toThrow(/requires.*agree/i);
  expect(() => resolvePortableManagedVolumeFormat({ ...base, version: 5 })).toThrow(/version 6/i);
  expect(() => resolvePortableManagedVolumeFormat({ ...base, version: 7 })).toThrow(/unsupported/i);
});

test("entries are exact, canonical, unique, bounded, and index-addressed", () => {
  expect(() => parsePortableManagedVolumeEntries([{ ...entry(), importedId: "attacker" }])).toThrow(/only target/i);
  expect(() => parsePortableManagedVolumeEntries([entry(), { ...entry(), archive: "volumes/1.tar" }])).toThrow(/duplicate/i);
  for (const target of ["relative", "/trailing/", "/a/../b", "/a\\b", "/a:b", "/a\0b"])
    expect(() => parsePortableManagedVolumeEntries([{ ...entry(), target }])).toThrow(/canonical/i);
  expect(() => parsePortableManagedVolumeEntries([{ ...entry(), name: " padded " }])).toThrow(/printable/i);
  expect(() => parsePortableManagedVolumeEntries([{ ...entry(), name: "bad\nname" }])).toThrow(/printable/i);
  expect(() => parsePortableManagedVolumeEntries([{ ...entry(), archive: "volumes/source-id.tar" }])).toThrow(/must be volumes\/0/i);
  expect(() => parsePortableManagedVolumeEntries(Array.from({ length: 33 }, (_, index) => entry(index)))).toThrow(/at most 32/i);
});
