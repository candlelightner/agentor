import { proxyPluginUi } from "../../../../../utils/plugin-ui-proxy";
import { pluginWebSocketTarget } from "../../../../../utils/plugin-ui-proxy";
import { createWsRelayHandlers, getPeerUrl } from "../../../../../utils/ws-utils";
const websocket = createWsRelayHandlers(
  /\/plugin-ui\/([^/?]+)/,
  (containerName, _workerId, peer) => pluginWebSocketTarget(getPeerUrl(peer) || '', containerName)!,
  (_workerId, peer) => Boolean(pluginWebSocketTarget(getPeerUrl(peer) || '', 'worker')),
);
export default defineEventHandler({ handler: (event) => proxyPluginUi(event), websocket });
