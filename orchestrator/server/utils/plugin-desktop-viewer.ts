/** First-party page: relative URLs survive an orchestrator reverse-proxy prefix.
 * Do not inject plugin HTML, command output, credentials, or the shared clipboard
 * bridge here. The RFB instance is scoped to this page's authorized display. */
export function pluginDesktopViewer(nonce: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugin desktop</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#171923;color:#edf2f7;font:14px system-ui}body{display:flex;flex-direction:column}header{padding:8px 12px;display:flex;gap:14px;align-items:center}button,a{color:inherit;background:#303847;border:1px solid #64748b;border-radius:4px;padding:5px 9px;text-decoration:none}#screen{flex:1;min-height:0;overflow:hidden}#detail{padding:0 12px;color:#fbbf24}</style></head><body>
<header><strong>Plugin desktop</strong><span id="state" role="status">Starting</span><button id="retry">Reconnect</button><a href="./" target="_blank" rel="noopener noreferrer">Open in tab</a><label><input id="scale" type="checkbox" checked> Fit to pane</label></header><p id="detail" role="alert"></p><div id="screen"></div>
<script type="module" nonce="${nonce}">
const state=document.querySelector('#state'),detail=document.querySelector('#detail'),screen=document.querySelector('#screen');
let rfb, timer, stopped=false, connecting=false;
function show(s,d=''){state.textContent=s;detail.textContent=d;document.body.dataset.desktopState=s.toLowerCase()}
async function connect(){if(stopped||connecting)return;connecting=true;clearTimeout(timer);
try {const response=await fetch('./status',{cache:'no-store'});const status=await response.json();
if(!response.ok){show('Failed',status.statusMessage||'Desktop access unavailable. Sign in again or check plugin access.');return}
if(!status.ready){show(status.state,status.error||(status.state==='Disabled'?'Enable this plugin in Plugins to open its desktop.':'Waiting for the worker and plugin desktop.'));timer=setTimeout(connect,2000);return}
if(status.mode==='shared'){location.reload();return}
const {default:RFB}=await import('./core/rfb.js');const url=new URL('./websockify',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
const previous=rfb;rfb=null;previous?.disconnect();screen.replaceChildren();show('Reconnecting');
const current=new RFB(screen,url.href);rfb=current;current.scaleViewport=document.querySelector('#scale').checked;current.resizeSession=false;
current.addEventListener('connect',()=>{if(rfb===current)show('Ready')});
current.addEventListener('disconnect',()=>{if(rfb!==current||stopped)return;show('Reconnecting','Connection closed. Retrying the authenticated desktop connection.');timer=setTimeout(connect,2000)});
current.addEventListener('securityfailure',()=>show('Failed','Desktop handshake failed. Retry or disable and enable the plugin.'));
}catch{show('Failed','Could not load the desktop. Check the worker status and retry.');timer=setTimeout(connect,3000)}finally{connecting=false}}
document.querySelector('#retry').onclick=()=>{clearTimeout(timer);connect()};document.querySelector('#scale').onchange=e=>{if(rfb)rfb.scaleViewport=e.target.checked};
addEventListener('beforeunload',()=>{stopped=true;clearTimeout(timer);rfb?.disconnect()});connect();
</script></body></html>`;
}
