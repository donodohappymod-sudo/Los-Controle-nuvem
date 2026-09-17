import dns from 'node:dns/promises';
import net from 'node:net';
import { parseM3U, M3UItem } from './m3u';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 20;
function isPrivateIp(ip:string){ if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168);} return ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:'); }
async function assertPublicUrl(raw:string){ const u=new URL(raw); if(!['http:','https:'].includes(u.protocol)) throw new Error('URL precisa usar HTTP ou HTTPS.'); const host=u.hostname; if(['localhost','127.0.0.1','0.0.0.0','::1'].includes(host.toLowerCase())) throw new Error('Endereço local não permitido.'); const ips=await dns.lookup(host,{all:true}); if(ips.some(x=>isPrivateIp(x.address))) throw new Error('Endereço privado/local não permitido.'); return u; }
async function fetchText(url:string){ const u=await assertPublicUrl(url); const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),20000); try { const r=await fetch(u,{signal:controller.signal,redirect:'manual',headers:{'User-Agent':'LOS-Collector/1.0'}}); if(!r.ok) throw new Error(`HTTP ${r.status}`); const len=Number(r.headers.get('content-length')||0); if(len>MAX_BYTES) throw new Error('Resposta excede o limite de 15 MB.'); const text=await r.text(); if(text.length>MAX_BYTES) throw new Error('Resposta excede o limite de 15 MB.'); return {url:u.toString(),response:r,text}; } finally {clearTimeout(timer);} }
export async function fetchPlaylist(url:string){ const {response,text}=await fetchText(url); const items=parseM3U(text); return {items,status:response.status,contentType:response.headers.get('content-type')||''}; }
export async function discoverPublicM3U(startUrl:string):Promise<M3UItem[]>{
  const first=await fetchText(startUrl); const direct=parseM3U(first.text); if(direct.length) return direct;
  const base=new URL(first.url); const queue=[base.toString()]; const seen=new Set<string>(); const all:M3UItem[]=[];
  while(queue.length && seen.size<MAX_PAGES){ const current=queue.shift()!; if(seen.has(current)) continue; seen.add(current); let page; try{page=current===first.url?first:await fetchText(current);}catch{continue;}
    const ct=page.response.headers.get('content-type')||''; if(/mpegurl|vnd.apple.mpegurl/i.test(ct)||/\.m3u8?(?:$|[?#])/i.test(current)){all.push(...parseM3U(page.text)); continue;}
    if(!/text\/html/i.test(ct) && !/<html/i.test(page.text)) continue;
    const hrefs=[...page.text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map(m=>m[1]);
    for(const href of hrefs){ try{const u=new URL(href,current); if(u.origin!==base.origin) continue; if(/\.m3u8?(?:$|[?#])/i.test(u.href)) queue.unshift(u.href); else if(queue.length+seen.size<MAX_PAGES && /^https?:$/i.test(u.protocol) && /playlist|stream|m3u|iptv|lista/i.test(u.href)) queue.push(u.href);}catch{} }
  }
  return dedupeItems(all);
}
function dedupeItems(items:M3UItem[]){const seen=new Set<string>();return items.filter(i=>{const k=i.url.trim().toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return true;});}
