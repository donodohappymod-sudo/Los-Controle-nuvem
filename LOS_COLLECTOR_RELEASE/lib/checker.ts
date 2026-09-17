import dns from 'node:dns/promises';
import net from 'node:net';
export type CheckResult={status:'ONLINE'|'ERRO'|'TIMEOUT';statusCode:number|null;responseMs:number|null};
function privateIp(ip:string){ if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168);} return ip==='::1'||ip.toLowerCase().startsWith('fc')||ip.toLowerCase().startsWith('fd')||ip.toLowerCase().startsWith('fe80:'); }
async function publicHttpUrl(raw:string){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw new Error('URL inválida');if(['localhost','127.0.0.1','0.0.0.0','::1'].includes(u.hostname.toLowerCase()))throw new Error('Endereço local');const ips=await dns.lookup(u.hostname,{all:true});if(ips.some(x=>privateIp(x.address)))throw new Error('Endereço privado');return u;}
export async function checkUrl(url:string, timeoutMs=8000):Promise<CheckResult>{
  const started=Date.now(); const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeoutMs);
  try { const u=await publicHttpUrl(url); const r=await fetch(u,{method:'GET',redirect:'manual',signal:c.signal,headers:{'User-Agent':'LOS-Collector-Checker/1.0','Range':'bytes=0-1'}}); return {status:r.ok || [301,302,303,307,308].includes(r.status)?'ONLINE':'ERRO',statusCode:r.status,responseMs:Date.now()-started}; }
  catch(e:any){ return {status:e?.name==='AbortError'?'TIMEOUT':'ERRO',statusCode:null,responseMs:Date.now()-started}; }
  finally{clearTimeout(t);}
}
