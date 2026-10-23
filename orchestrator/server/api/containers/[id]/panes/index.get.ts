defineRouteMeta({
  openAPI: {
    tags: ['Tmux'],
    summary: 'List tmux windows',
    description: 'Returns tmux windows only for confirmed running compute. A stopped worker returns 409; unknown, unresponsive, or changing compute returns 503 with WORKER_PANES_UNAVAILABLE. Refresh inventory before retrying.',
    operationId: 'listTmuxWindows',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' }],
    responses: {
      409: { description: 'Confirmed stopped worker; panes unavailable' },
      503: { description: 'Runtime unconfirmed, unresponsive, or changing; panes unavailable' },
      200: {
        description: 'Array of tmux windows',
        content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/TmuxWindow' } } } },
      },
    },
    $global: {
      components: {
        schemas: {
          TmuxWindow: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              name: { type: 'string' },
              active: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
});

import { useContainerManager } from '../../../../utils/services';
import { requireContainerAccess } from '../../../../utils/auth-helpers';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireContainerAccess(event, containerManager.get(id));
  return containerManager.listTmuxWindows(id);
});
