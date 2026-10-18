import { defineConfig } from '@playwright/test';
import modules from './playwright.modules.config';

// Actual recovery modal/composable with private HTTP fixtures; no live stack.
export default defineConfig({ ...modules, testMatch: ['ui/admin-native-instance-isolated.spec.ts'] });
