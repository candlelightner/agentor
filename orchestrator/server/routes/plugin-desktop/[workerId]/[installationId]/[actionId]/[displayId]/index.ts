import { proxyPluginDesktop, pluginDesktopWebSocket } from "../../../../../../utils/plugin-desktop-proxy";
export default defineEventHandler({ handler: proxyPluginDesktop, websocket: pluginDesktopWebSocket });
