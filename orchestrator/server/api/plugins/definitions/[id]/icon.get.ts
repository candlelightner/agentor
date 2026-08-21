defineRouteMeta({ openAPI: { tags: ['Plugins'], summary: 'Get sanitized plugin icon', description: 'Returns the definition icon as sanitized SVG. Missing icons receive a safe default SVG.', operationId: 'getPluginDefinitionIcon', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Sanitized SVG icon', content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } } }, 401: { description: 'Unauthorized' }, 404: { description: 'Definition not found or not accessible' } } } });

import { requireAuth } from '../../../../utils/auth-helpers';
import { usePluginDefinitionStore } from '../../../../utils/services';
import { sanitizePluginSvgOrDefault } from '../../../../utils/plugin-svg';

export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const definition = usePluginDefinitionStore().getById(getRouterParam(event, 'id')!);
  const visible = definition && (
    definition.scope === 'platform' ||
    user.role === 'admin' ||
    definition.userId === user.id
  );
  if (!visible)
    throw createError({ statusCode: 404, statusMessage: 'Plugin definition not found' });
  const { svg } = sanitizePluginSvgOrDefault(definition.manifest.iconSvg);
  setHeader(event, 'Content-Type', 'image/svg+xml; charset=utf-8');
  setHeader(event, 'Cache-Control', 'private, max-age=300');
  setHeader(event, 'Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox");
  setHeader(event, 'X-Content-Type-Options', 'nosniff');
  return svg;
});
