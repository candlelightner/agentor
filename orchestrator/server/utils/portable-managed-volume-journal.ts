import {
  deterministicPortableManagedVolumeId,
  type PortableManagedVolumeImportIntent,
} from "./portable-managed-volume-plan";
import { parsePortableManagedVolumeEntries } from "./portable-managed-volume-format";

export const PORTABLE_MANAGED_VOLUME_JOURNAL_VERSION = 1;

export type PortableManagedVolumeResourceState =
  | "intent" | "create-pending" | "create-uncertain" | "created"
  | "restore-pending" | "restore-uncertain" | "restored"
  | "delete-pending" | "cleanup-debt" | "deleted-confirmed";

export type PortableManagedVolumeWorkerState =
  | "intent" | "create-pending" | "create-uncertain" | "created"
  | "delete-pending" | "cleanup-debt" | "deleted-confirmed";

export type PortableManagedVolumeCleanupStatus =
  | "not-required" | "required" | "ambiguous" | "debt" | "confirmed";

export type PortableManagedVolumeJournalPhase =
  | "prepared" | "provisioning" | "worker-pending" | "worker-created"
  | "rollback" | "cleanup-debt" | "committed";

export interface PortableManagedVolumeJournalResource extends PortableManagedVolumeImportIntent {
  index: number;
  state: PortableManagedVolumeResourceState;
  cleanupStatus: PortableManagedVolumeCleanupStatus;
}

export interface PortableManagedVolumeProvisionalWorker {
  state: PortableManagedVolumeWorkerState;
  cleanupStatus: PortableManagedVolumeCleanupStatus;
  expectedLabels: {
    "agentor.owner-id": string;
    "agentor.worker-id": string;
    "agentor.portable-import-id": string;
  };
}

export interface PortableManagedVolumeImportJournal {
  version: 1;
  operationId: string;
  userId: string;
  workerId: string;
  phase: PortableManagedVolumeJournalPhase;
  createdAt: string;
  updatedAt: string;
  resources: PortableManagedVolumeJournalResource[];
  provisionalWorker: PortableManagedVolumeProvisionalWorker;
}

const RESOURCE_TRANSITIONS: Record<PortableManagedVolumeResourceState, readonly PortableManagedVolumeResourceState[]> = {
  intent: ["create-pending"],
  "create-pending": ["created", "create-uncertain"],
  "create-uncertain": ["created", "delete-pending"],
  created: ["restore-pending", "delete-pending"],
  "restore-pending": ["restored", "restore-uncertain"],
  "restore-uncertain": ["restored", "delete-pending"],
  restored: ["delete-pending"],
  "delete-pending": ["deleted-confirmed", "cleanup-debt"],
  "cleanup-debt": ["delete-pending"],
  "deleted-confirmed": [],
};

const WORKER_TRANSITIONS: Record<PortableManagedVolumeWorkerState, readonly PortableManagedVolumeWorkerState[]> = {
  intent: ["create-pending"],
  "create-pending": ["created", "create-uncertain"],
  "create-uncertain": ["created", "delete-pending"],
  created: ["delete-pending"],
  "delete-pending": ["deleted-confirmed", "cleanup-debt"],
  "cleanup-debt": ["delete-pending"],
  "deleted-confirmed": [],
};

const PHASE_TRANSITIONS: Record<PortableManagedVolumeJournalPhase, readonly PortableManagedVolumeJournalPhase[]> = {
  prepared: ["provisioning", "rollback"],
  provisioning: ["worker-pending", "rollback"],
  "worker-pending": ["worker-created", "rollback"],
  "worker-created": ["committed", "rollback"],
  rollback: ["cleanup-debt"],
  "cleanup-debt": ["rollback"],
  committed: [],
};

export function createPortableManagedVolumeImportJournal(input: {
  operationId: string;
  userId: string;
  workerId: string;
  resources: readonly PortableManagedVolumeImportIntent[];
  now?: string;
}): PortableManagedVolumeImportJournal {
  const now = parseTimestamp(input.now ?? new Date().toISOString(), "now");
  const journal: PortableManagedVolumeImportJournal = {
    version: PORTABLE_MANAGED_VOLUME_JOURNAL_VERSION,
    operationId: input.operationId,
    userId: input.userId,
    workerId: input.workerId,
    phase: "prepared",
    createdAt: now,
    updatedAt: now,
    resources: input.resources.map((resource, index) => ({
      ...resource,
      labels: { ...resource.labels },
      index,
      state: "intent",
      cleanupStatus: "not-required",
    })),
    provisionalWorker: {
      state: "intent",
      cleanupStatus: "not-required",
      expectedLabels: {
        "agentor.owner-id": input.userId,
        "agentor.worker-id": input.workerId,
        "agentor.portable-import-id": input.operationId,
      },
    },
  };
  return parsePortableManagedVolumeImportJournal(journal);
}

export function parsePortableManagedVolumeImportJournal(value: unknown): PortableManagedVolumeImportJournal {
  if (!exactRecord(value, ["version", "operationId", "userId", "workerId", "phase", "createdAt", "updatedAt", "resources", "provisionalWorker"]) ||
      value.version !== PORTABLE_MANAGED_VOLUME_JOURNAL_VERSION)
    throw invalidJournal();
  const operationId = parseIdentifier(value.operationId);
  const userId = parseIdentifier(value.userId);
  const workerId = parseIdentifier(value.workerId);
  const phase = parseEnum(value.phase, Object.keys(PHASE_TRANSITIONS) as PortableManagedVolumeJournalPhase[]);
  const createdAt = parseTimestamp(value.createdAt, "createdAt");
  const updatedAt = parseTimestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw invalidJournal();
  if (!Array.isArray(value.resources) || value.resources.length > 32) throw invalidJournal();
  const resources = value.resources.map((resource, index) => parseResource(resource, index, { operationId, userId, workerId }));
  parsePortableManagedVolumeEntries(resources.map(({ target, name, archive }) => ({ target, name, archive })));
  const provisionalWorker = parseWorker(value.provisionalWorker, { operationId, userId, workerId });
  const journal: PortableManagedVolumeImportJournal = {
    version: 1, operationId, userId, workerId, phase, createdAt, updatedAt,
    resources, provisionalWorker,
  };
  validatePhaseState(journal);
  return journal;
}

export function transitionPortableManagedVolumeResource(
  journalInput: PortableManagedVolumeImportJournal,
  index: number,
  nextState: PortableManagedVolumeResourceState,
  now = new Date().toISOString(),
): PortableManagedVolumeImportJournal {
  const journal = parsePortableManagedVolumeImportJournal(journalInput);
  if (!Number.isSafeInteger(index) || index < 0 || index >= journal.resources.length)
    throw new Error("Invalid portable managed-volume journal resource index");
  const resource = journal.resources[index]!;
  if (!RESOURCE_TRANSITIONS[resource.state].includes(nextState))
    throw new Error(`Invalid portable managed-volume resource transition: ${resource.state} -> ${nextState}`);
  if (isDeleteState(nextState)) requireRollbackPhase(journal.phase);
  else if ((nextState === "create-uncertain" || nextState === "restore-uncertain") &&
      (journal.phase === "rollback" || journal.phase === "cleanup-debt")) {
    // A restart/rollback must first make an in-flight mutation explicitly
    // uncertain before it can persist a delete attempt.
  } else if (journal.phase !== "provisioning")
    throw new Error("Portable managed-volume resource provisioning requires the provisioning phase");
  const resources = journal.resources.map((candidate, candidateIndex) => candidateIndex === index
    ? { ...candidate, state: nextState, cleanupStatus: cleanupStatusForState(nextState) }
    : candidate);
  return parsePortableManagedVolumeImportJournal({ ...journal, resources, updatedAt: parseTimestamp(now, "now") });
}

export function transitionPortableManagedVolumeWorker(
  journalInput: PortableManagedVolumeImportJournal,
  nextState: PortableManagedVolumeWorkerState,
  now = new Date().toISOString(),
): PortableManagedVolumeImportJournal {
  const journal = parsePortableManagedVolumeImportJournal(journalInput);
  const current = journal.provisionalWorker.state;
  if (!WORKER_TRANSITIONS[current].includes(nextState))
    throw new Error(`Invalid portable managed-volume worker transition: ${current} -> ${nextState}`);
  if (isDeleteState(nextState)) requireRollbackPhase(journal.phase);
  else if (nextState === "create-uncertain" &&
      (journal.phase === "rollback" || journal.phase === "cleanup-debt")) {
    // Preserve ambiguity before cleanup after a crash or timed-out creation.
  } else if (journal.phase !== "worker-pending")
    throw new Error("Portable managed-volume worker creation requires the worker-pending phase");
  return parsePortableManagedVolumeImportJournal({
    ...journal,
    updatedAt: parseTimestamp(now, "now"),
    provisionalWorker: {
      ...journal.provisionalWorker,
      state: nextState,
      cleanupStatus: cleanupStatusForState(nextState),
    },
  });
}

export function transitionPortableManagedVolumeJournalPhase(
  journalInput: PortableManagedVolumeImportJournal,
  nextPhase: PortableManagedVolumeJournalPhase,
  now = new Date().toISOString(),
): PortableManagedVolumeImportJournal {
  const journal = parsePortableManagedVolumeImportJournal(journalInput);
  if (!PHASE_TRANSITIONS[journal.phase].includes(nextPhase))
    throw new Error(`Invalid portable managed-volume journal phase transition: ${journal.phase} -> ${nextPhase}`);
  if (nextPhase === "worker-pending" && journal.resources.some((resource) => resource.state !== "restored"))
    throw new Error("All portable managed volumes must be restored before worker creation");
  if (nextPhase === "worker-created" && journal.provisionalWorker.state !== "created")
    throw new Error("The provisional worker must be positively confirmed before worker-created");
  if (nextPhase === "committed" && (journal.provisionalWorker.state !== "created" ||
      journal.resources.some((resource) => resource.state !== "restored")))
    throw new Error("Portable managed-volume import cannot commit incomplete resources");
  if (nextPhase === "cleanup-debt" && !hasCleanupDebt(journal))
    throw new Error("Portable managed-volume journal has no cleanup debt");
  return parsePortableManagedVolumeImportJournal({ ...journal, phase: nextPhase, updatedAt: parseTimestamp(now, "now") });
}

export function isPortableManagedVolumeImportJournalTerminal(
  journalInput: PortableManagedVolumeImportJournal,
): boolean {
  const journal = parsePortableManagedVolumeImportJournal(journalInput);
  if (journal.phase === "committed") return true;
  if (journal.phase !== "rollback") return false;
  const resourcesClean = journal.resources.every((resource) =>
    resource.state === "intent" || resource.state === "deleted-confirmed");
  const workerClean = journal.provisionalWorker.state === "intent" ||
    journal.provisionalWorker.state === "deleted-confirmed";
  return resourcesClean && workerClean;
}

function parseResource(
  value: unknown,
  index: number,
  owner: { operationId: string; userId: string; workerId: string },
): PortableManagedVolumeJournalResource {
  if (!exactRecord(value, ["index", "id", "dockerName", "target", "name", "archive", "labels", "state", "cleanupStatus"]) ||
      value.index !== index || typeof value.id !== "string" || !UUID_RE.test(value.id) ||
      value.id !== deterministicPortableManagedVolumeId(owner.operationId, index) ||
      value.dockerName !== `agentor-persist-${value.id}` || typeof value.target !== "string" ||
      typeof value.name !== "string" || value.archive !== `volumes/${index}.tar`)
    throw invalidJournal();
  const state = parseEnum(value.state, Object.keys(RESOURCE_TRANSITIONS) as PortableManagedVolumeResourceState[]);
  const cleanupStatus = parseEnum(value.cleanupStatus, CLEANUP_STATUSES);
  if (cleanupStatus !== cleanupStatusForState(state)) throw invalidJournal();
  if (!exactRecord(value.labels, ["agentor.volume-id", "agentor.owner-id", "agentor.worker-id", "agentor.portable-import-id"]) ||
      value.labels["agentor.volume-id"] !== value.id || value.labels["agentor.owner-id"] !== owner.userId ||
      value.labels["agentor.worker-id"] !== owner.workerId || value.labels["agentor.portable-import-id"] !== owner.operationId)
    throw invalidJournal();
  return {
    index,
    id: value.id,
    dockerName: value.dockerName,
    target: value.target,
    name: value.name,
    archive: value.archive,
    labels: {
      "agentor.volume-id": value.id,
      "agentor.owner-id": owner.userId,
      "agentor.worker-id": owner.workerId,
      "agentor.portable-import-id": owner.operationId,
    },
    state,
    cleanupStatus,
  };
}

function parseWorker(
  value: unknown,
  owner: { operationId: string; userId: string; workerId: string },
): PortableManagedVolumeProvisionalWorker {
  if (!exactRecord(value, ["state", "cleanupStatus", "expectedLabels"])) throw invalidJournal();
  const state = parseEnum(value.state, Object.keys(WORKER_TRANSITIONS) as PortableManagedVolumeWorkerState[]);
  const cleanupStatus = parseEnum(value.cleanupStatus, CLEANUP_STATUSES);
  if (cleanupStatus !== cleanupStatusForState(state) ||
      !exactRecord(value.expectedLabels, ["agentor.owner-id", "agentor.worker-id", "agentor.portable-import-id"]) ||
      value.expectedLabels["agentor.owner-id"] !== owner.userId ||
      value.expectedLabels["agentor.worker-id"] !== owner.workerId ||
      value.expectedLabels["agentor.portable-import-id"] !== owner.operationId)
    throw invalidJournal();
  return {
    state,
    cleanupStatus,
    expectedLabels: {
      "agentor.owner-id": owner.userId,
      "agentor.worker-id": owner.workerId,
      "agentor.portable-import-id": owner.operationId,
    },
  };
}

const CLEANUP_STATUSES: PortableManagedVolumeCleanupStatus[] = ["not-required", "required", "ambiguous", "debt", "confirmed"];
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function cleanupStatusForState(state: PortableManagedVolumeResourceState | PortableManagedVolumeWorkerState): PortableManagedVolumeCleanupStatus {
  if (state === "intent") return "not-required";
  if (state === "created" || state === "restore-pending" || state === "restored") return "required";
  if (state === "cleanup-debt") return "debt";
  if (state === "deleted-confirmed") return "confirmed";
  return "ambiguous";
}

function hasCleanupDebt(journal: PortableManagedVolumeImportJournal): boolean {
  return journal.provisionalWorker.cleanupStatus === "debt" ||
    journal.resources.some((resource) => resource.cleanupStatus === "debt");
}

function validatePhaseState(journal: PortableManagedVolumeImportJournal): void {
  const worker = journal.provisionalWorker.state;
  const resources = journal.resources.map((resource) => resource.state);
  if (journal.phase === "prepared" &&
      (worker !== "intent" || resources.some((state) => state !== "intent")))
    throw invalidJournal();
  if (journal.phase === "provisioning" &&
      (worker !== "intent" || resources.some((state) => isDeleteState(state))))
    throw invalidJournal();
  if (journal.phase === "worker-pending" &&
      (resources.some((state) => state !== "restored") ||
       !(["intent", "create-pending", "create-uncertain", "created"] as PortableManagedVolumeWorkerState[]).includes(worker)))
    throw invalidJournal();
  if ((journal.phase === "worker-created" || journal.phase === "committed") &&
      (worker !== "created" || resources.some((state) => state !== "restored")))
    throw invalidJournal();
  if (journal.phase === "cleanup-debt") {
    const allowedWorker: PortableManagedVolumeWorkerState[] = ["intent", "cleanup-debt", "deleted-confirmed"];
    const allowedResource: PortableManagedVolumeResourceState[] = [
      "intent", "create-uncertain", "created", "restore-uncertain", "restored",
      "cleanup-debt", "deleted-confirmed",
    ];
    if (!hasCleanupDebt(journal) || !allowedWorker.includes(worker) ||
        resources.some((state) => !allowedResource.includes(state)))
      throw invalidJournal();
  }
}

function isDeleteState(state: PortableManagedVolumeResourceState | PortableManagedVolumeWorkerState): boolean {
  return state === "delete-pending" || state === "cleanup-debt" || state === "deleted-confirmed";
}

function requireRollbackPhase(phase: PortableManagedVolumeJournalPhase): void {
  if (phase !== "rollback" && phase !== "cleanup-debt")
    throw new Error("Portable managed-volume cleanup requires rollback or cleanup-debt phase");
}

function parseIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw invalidJournal();
  return value;
}

function parseTimestamp(value: unknown, _field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw invalidJournal();
  return value;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalidJournal();
  return value as T;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = [...keys].sort();
  const actual = Object.keys(value as object).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidJournal(): Error {
  return new Error("Invalid portable managed-volume import journal");
}
