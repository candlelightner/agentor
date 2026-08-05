/** Diagnostic routes exercise the real authorization/policy/runtime code path
 * but must not exist in a normal production deployment. */
export function requireAdminDiagnostics(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.ALLOW_ADMIN_DIAGNOSTICS !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }
}
