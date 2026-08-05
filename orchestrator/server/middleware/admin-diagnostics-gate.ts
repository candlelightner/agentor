import { requireAdminDiagnostics } from '../utils/admin-diagnostics';

export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/admin/') && event.path.includes('/diagnostics/')) requireAdminDiagnostics();
});
