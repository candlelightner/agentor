import { defineConfig } from '@playwright/test';
import modules from './playwright.modules.config';
export default defineConfig({ ...modules, testMatch: ['api/admin-native-portable-backup.spec.ts', 'ui/admin-native-portable-backup-isolated.spec.ts'] });
