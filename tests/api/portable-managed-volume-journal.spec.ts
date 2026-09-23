import { expect, test } from "@playwright/test";
import {
  createPortableManagedVolumeImportJournal,
  isPortableManagedVolumeImportJournalTerminal,
  parsePortableManagedVolumeImportJournal,
  transitionPortableManagedVolumeJournalPhase,
  transitionPortableManagedVolumeResource,
  transitionPortableManagedVolumeWorker,
  type PortableManagedVolumeImportJournal,
} from "../../orchestrator/server/utils/portable-managed-volume-journal";
import { planPortableManagedVolumeImport } from "../../orchestrator/server/utils/portable-managed-volume-plan";

const NOW = "2026-09-22T00:00:00.000Z";

function fresh(): PortableManagedVolumeImportJournal {
  const resources = planPortableManagedVolumeImport({
    operationId: "journal-operation",
    userId: "owner-a",
    workerId: "worker-a",
    entries: [{ target: "/srv/data", name: "data", archive: "volumes/0.tar" }],
    conflicts: {
      protectedPaths: [], workspacePaths: [], agentDataPaths: [], dockerDataPaths: [],
      hostGrantPaths: [], destinationMountPaths: [], selectedBackupPaths: [],
    },
  });
  return createPortableManagedVolumeImportJournal({
    operationId: "journal-operation",
    userId: "owner-a",
    workerId: "worker-a",
    resources,
    now: NOW,
  });
}

function transitionResource(journal: PortableManagedVolumeImportJournal, state: Parameters<typeof transitionPortableManagedVolumeResource>[2]) {
  return transitionPortableManagedVolumeResource(journal, 0, state, NOW);
}

test("journal records deterministic intents and exact positive ownership labels", () => {
  const journal = fresh();
  expect(journal).toMatchObject({
    version: 1,
    operationId: "journal-operation",
    userId: "owner-a",
    workerId: "worker-a",
    phase: "prepared",
    createdAt: NOW,
    updatedAt: NOW,
    provisionalWorker: {
      state: "intent",
      cleanupStatus: "not-required",
      expectedLabels: {
        "agentor.owner-id": "owner-a",
        "agentor.worker-id": "worker-a",
        "agentor.portable-import-id": "journal-operation",
      },
    },
  });
  expect(journal.resources[0]).toMatchObject({
    index: 0,
    dockerName: `agentor-persist-${journal.resources[0]?.id}`,
    state: "intent",
    cleanupStatus: "not-required",
    labels: {
      "agentor.volume-id": journal.resources[0]?.id,
      "agentor.owner-id": "owner-a",
      "agentor.worker-id": "worker-a",
      "agentor.portable-import-id": "journal-operation",
    },
  });
});

test("strict parser rejects unknown data, altered identities, labels, and cleanup claims", () => {
  const journal = fresh();
  for (const invalid of [
    { ...journal, attackerField: true },
    { ...journal, operationId: "other" },
    { ...journal, resources: [{ ...journal.resources[0], id: "00000000-0000-4000-8000-000000000000" }] },
    { ...journal, resources: [{ ...journal.resources[0], cleanupStatus: "confirmed" }] },
    { ...journal, resources: [{ ...journal.resources[0], labels: { ...journal.resources[0]?.labels, "agentor.owner-id": "attacker" } }] },
    { ...journal, provisionalWorker: { ...journal.provisionalWorker, expectedLabels: { ...journal.provisionalWorker.expectedLabels, extra: "bad" } } },
  ]) expect(() => parsePortableManagedVolumeImportJournal(invalid)).toThrow(/invalid portable/i);
});

test("happy-path transitions require restore and positive worker confirmation before commit", () => {
  let journal = transitionPortableManagedVolumeJournalPhase(fresh(), "provisioning", NOW);
  journal = transitionResource(journal, "create-pending");
  expect(journal.resources[0]?.cleanupStatus).toBe("ambiguous");
  journal = transitionResource(journal, "created");
  expect(journal.resources[0]?.cleanupStatus).toBe("required");
  expect(() => transitionPortableManagedVolumeJournalPhase(journal, "worker-pending", NOW)).toThrow(/must be restored/i);
  journal = transitionResource(journal, "restore-pending");
  journal = transitionResource(journal, "restored");
  journal = transitionPortableManagedVolumeJournalPhase(journal, "worker-pending", NOW);
  expect(() => transitionPortableManagedVolumeJournalPhase(journal, "worker-created", NOW)).toThrow(/positively confirmed/i);
  journal = transitionPortableManagedVolumeWorker(journal, "create-pending", NOW);
  journal = transitionPortableManagedVolumeWorker(journal, "created", NOW);
  journal = transitionPortableManagedVolumeJournalPhase(journal, "worker-created", NOW);
  journal = transitionPortableManagedVolumeJournalPhase(journal, "committed", NOW);
  expect(isPortableManagedVolumeImportJournalTerminal(journal)).toBe(true);
});

test("ambiguous creation cannot become confirmed deletion without a persisted delete attempt", () => {
  let journal = transitionPortableManagedVolumeJournalPhase(fresh(), "provisioning", NOW);
  journal = transitionResource(journal, "create-pending");
  journal = transitionResource(journal, "create-uncertain");
  journal = transitionPortableManagedVolumeJournalPhase(journal, "rollback", NOW);
  expect(() => transitionResource(journal, "deleted-confirmed")).toThrow(/invalid.*transition/i);
  journal = transitionResource(journal, "delete-pending");
  journal = transitionResource(journal, "deleted-confirmed");
  expect(journal.resources[0]?.cleanupStatus).toBe("confirmed");
  expect(isPortableManagedVolumeImportJournalTerminal(journal)).toBe(true);
});

test("cleanup debt is explicit, non-terminal, and retryable", () => {
  let journal = transitionPortableManagedVolumeJournalPhase(fresh(), "provisioning", NOW);
  journal = transitionResource(journal, "create-pending");
  journal = transitionResource(journal, "created");
  journal = transitionPortableManagedVolumeJournalPhase(journal, "rollback", NOW);
  journal = transitionResource(journal, "delete-pending");
  journal = transitionResource(journal, "cleanup-debt");
  expect(journal.resources[0]?.cleanupStatus).toBe("debt");
  journal = transitionPortableManagedVolumeJournalPhase(journal, "cleanup-debt", NOW);
  expect(isPortableManagedVolumeImportJournalTerminal(journal)).toBe(false);
  journal = transitionPortableManagedVolumeJournalPhase(journal, "rollback", NOW);
  journal = transitionResource(journal, "delete-pending");
  journal = transitionResource(journal, "deleted-confirmed");
  expect(isPortableManagedVolumeImportJournalTerminal(journal)).toBe(true);
});

test("phase and resource shortcuts are rejected", () => {
  const journal = fresh();
  expect(() => transitionResource(journal, "create-pending")).toThrow(/provisioning phase/i);
  expect(() => transitionPortableManagedVolumeJournalPhase(journal, "committed", NOW)).toThrow(/invalid.*phase transition/i);
  expect(() => transitionPortableManagedVolumeWorker(journal, "create-pending", NOW)).toThrow(/worker-pending phase/i);
  expect(isPortableManagedVolumeImportJournalTerminal(journal)).toBe(false);
  const rolledBack = transitionPortableManagedVolumeJournalPhase(journal, "rollback", NOW);
  expect(isPortableManagedVolumeImportJournalTerminal(rolledBack)).toBe(true);
});

test("strict parser rejects unreachable phase and persisted worker-state combinations", () => {
  const prepared = fresh();
  const provisioning = transitionPortableManagedVolumeJournalPhase(prepared, "provisioning", NOW);
  let restored = transitionResource(provisioning, "create-pending");
  restored = transitionResource(restored, "created");
  restored = transitionResource(restored, "restore-pending");
  restored = transitionResource(restored, "restored");
  const workerPending = transitionPortableManagedVolumeJournalPhase(restored, "worker-pending", NOW);
  for (const state of ["cleanup-debt", "deleted-confirmed"] as const) {
    expect(() => parsePortableManagedVolumeImportJournal({
      ...workerPending,
      provisionalWorker: {
        ...workerPending.provisionalWorker,
        state,
        cleanupStatus: state === "cleanup-debt" ? "debt" : "confirmed",
      },
    })).toThrow(/invalid portable/i);
  }
  expect(() => parsePortableManagedVolumeImportJournal({
    ...workerPending,
    phase: "cleanup-debt",
    provisionalWorker: { ...workerPending.provisionalWorker, state: "cleanup-debt", cleanupStatus: "debt" },
    resources: [{ ...workerPending.resources[0], state: "restore-pending", cleanupStatus: "required" }],
  })).toThrow(/invalid portable/i);
});
