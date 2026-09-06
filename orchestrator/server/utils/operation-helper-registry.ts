/**
 * Process-local ownership for short-lived Docker operation helpers. Docker's
 * `running` state is not proof that a helper still has a live request owner;
 * after cancellation or an ambiguous create response it may be an orphan.
 *
 * Only server-generated operation ids are retained. No Docker ids, user data,
 * credentials, archive paths, or other request material enter this registry.
 */
const activeOperationIds = new Set<string>();

export function registerOperationHelper(operationId: string): () => void {
  activeOperationIds.add(operationId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeOperationIds.delete(operationId);
  };
}

export function isOperationHelperActive(operationId: unknown): boolean {
  return typeof operationId === "string" && activeOperationIds.has(operationId);
}
