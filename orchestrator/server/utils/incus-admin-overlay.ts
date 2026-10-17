import { createHash } from 'node:crypto';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner } from './admin-native-authority';

export function administrativeNativeOverlay(record: Readonly<AdministrativeWorkspaceRecord>) {
    const owner = administrativeRuntimeOwner(record);
    const banner = owner.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR';
    return {
        '/etc/profile.d/agentor-admin.sh': { mode: 0o644, content: `export AGENTOR_ADMIN_WORKSPACE=1\nexport PS1='[${banner}] \\u@\\h:\\w \\$ '\n` },
        '/etc/agentor-admin': { mode: 0o644, content: banner + '\n' },
        '/usr/local/bin/agentor-admin-start-gate': { mode: 0o755, content: '#!/bin/sh\nset -eu\nwhile [ ! -s /run/agentor-management/credential ]; do sleep 0.05; done\nexec "$@"\n' },
    };
}
export function administrativeNativeOverlaySha256(record: Readonly<AdministrativeWorkspaceRecord>) {
    return createHash('sha256').update(JSON.stringify(administrativeNativeOverlay(record))).digest('hex');
}
