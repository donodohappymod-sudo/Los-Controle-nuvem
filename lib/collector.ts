import dns from 'node:dns/promises';
import net from 'node:net';
import { parseM3U, M3UItem, classify } from './m3u';

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 80;
const MAX_QUEUE = 160;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'LOS-Collector/2.0';

function isPrivateIp(ip:string) {
  if (net.isIPv4(ip)) {
    const p=ip.split('.').map(Number);
    return p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) ||
      (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168);
  }
  const v=ip.toLowerCase();
  return v==='::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
}

async function assertPublicUrl(raw:string) {
  let u:URL;
  try { u=new URL(raw); } catch { throw new Error('URL inválida. Use http:// ou https://.'); }
  if(!['http:','https:'].includes(u.protocol)) throw new Error('URL precisa usar HTTP ou HTTPS.');
  const host=u.hostname.toLowerCase();
  if(['localhost','127.0.0.1','0.0.0.0','::1'].includes(host)) throw new Error('Endereço local não permitido.');
  const ips=await dns.lookup(host,{all:true});
  if(ips.some(x=>isPrivateIp(x.address))) throw new Error('Endereço privado/local não permitido.');
  return u;
}

async function fetchText(url:string) {
  const u=await assertPublicUrl(url);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try {
    const r=await fetch(u,{signal:controller.signal,redirect:'follow',headers:{'User-Agent':USER_AGENT,'Accept':'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,application/json,*/*'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const len=Number(r.headers.get('content-length')||0);
    if(len>MAX_BYTES) throw new Error('Resposta excede o limite permitido.');
    const text=await r.text();
    if(text.length>MAX_BYTES) throw new Error('Resposta excede o limite permitido.');
    return {url:r.url||u.toString(),response:r,text};
  } catch(e:any) {
    if(e?.name==='AbortError') throw new Error('Tempo limite excedido.');
    throw e;
  } finally { clearTimeout(timer); }
}

export async function fetchPlaylist(url:string) {
  const {response,text}=await fetchText(url);
  return {items:parseM3U(text),status:response.status,contentType:response.headers.get('content-type')||''};
}

function abs(raw:string,base:string) {
  try { return new URL(raw,base).toString(); } catch { return ''; }
}

function cleanText(v:string) {
  return v.replace(/\s+/g,' ').replace(/&amp;/g,'&').trim();
}

function decodeHtml(v:string) {
  return v.replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|apos|lt|gt);/g,m=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'}[m]||m)).replace(/\s+/g,' ').trim();
}

function categoryFrom(text:string) {
  return classify('',text);
}

function itemFrom(url:string,title:string,group='',logo='',attrs:Record<string,string>={}):M3UItem {
  const t=cleanText(title)||url;
  return {title:t,url,group:cleanText(group),logo:logo||'',category:categoryFrom(`${group} ${t}`),attrs};
}

function addMediaLinks(html:string,pageUrl:string,baseTitle:string,baseGroup:string,items:M3UItem[]) {
  const patterns=[
    /(?:href|src|data-src|data-url|data-stream|content)=["']([^"']+)["']/gi,
    /https?:\/\/[^"'\s<>]+/gi
  ];
  for(const re of patterns) {
    for(const m of html.matchAll(re)) {
      const raw=(m[1]||m[0]).replace(/&amp;/g,'&');
      const u=abs(raw,pageUrl);
      if(!u || !/^https?:/i.test(u)) continue;
      if(!/\.(?:m3u8?|mpd|mp4|webm|mov|mkv)(?:$|[?#])/i.test(u) && !/(?:m3u8|playlist|manifest|stream|live|video)/i.test(u)) continue;
      items.push(itemFrom(u,baseTitle,baseGroup,''));
    }
  }
}

function extractJsonLd(html:string,pageUrl:string,items:M3UItem[]) {
  for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\\+json["'][^>]*>([\s\\S]*?)<\/script>/gi)) {
    try {
      const raw=JSON.parse(m[1].trim());
      const list=Array.isArray(raw)?raw:[raw];
      for(const obj of list) {
        if(!obj || typeof obj!=='object') continue;
        const title=cleanText(String(obj.name||obj.headline||''));
        const image=typeof obj.image==='string'?obj.image:'';
        const url=typeof obj.url==='string'?abs(obj.url,pageUrl):'';
        if(title && url && /^https?:/i.test(url)) items.push(itemFrom(url,title,'',image));
      }
    } catch {}
  }
}

function extractPageLinks(html:string,pageUrl:string,baseOrigin:string) {
  const out:string[]=[];
  for(const m of html.matchAll(/<(?:a|link|iframe|video|source)[^>]+(?:href|src)=["']([^"']+)["']/gi)) {
    const u=abs(m[1],pageUrl);
    if(!u || !/^https?:/i.test(u)) continue;
    try {
      const parsed=new URL(u);
      if(parsed.origin===baseOrigin) out.push(u);
    } catch {}
  }
  return [...new Set(out)];
}

function likelyCatalogPage(url:string) {
  return /(?:movie|filme|series|serie|season|temporada|episode|episodio|show|anime|tv|channel|canal|watch|assistir|player|video|catalog|categoria|category|playlist|stream|live)/i.test(url);
}

function dedupeItems(items:M3UItem[]) {
  const seen=new Set<string>();
  return items.filter(i=>{
    const k=i.url.trim().toLowerCase();
    if(!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export async function discoverPublicM3U(startUrl:string):Promise<M3UItem[]> {
  const first=await fetchText(startUrl);
  const direct=parseM3U(first.text);
  if(direct.length) return dedupeItems(direct);

  const base=new URL(first.url);
  const queue=[base.toString()];
  const queued=new Set(queue);
  const seen=new Set<string>();
  const all:M3UItem[]=[];

  while(queue.length && seen.size<MAX_PAGES) {
    const current=queue.shift()!;
    if(seen.has(current)) continue;
    seen.add(current);

    let page:any;
    try { page=current===first.url?first:await fetchText(current); }
    catch { continue; }

    const ct=page.response.headers.get('content-type')||'';
    const isManifest=/mpegurl|dash|vnd.apple.mpegurl/i.test(ct)||/\.(?:m3u8?|mpd)(?:$|[?#])/i.test(current);
    if(isManifest) {
      all.push(...parseM3U(page.text));
      continue;
    }
    if(!/html|xml|json|text\//i.test(ct) && !/<html|<body|<video|<script/i.test(page.text)) continue;

    const titleMatch=page.text.match(/<title[^>]*>([\s\\S]*?)<\/title>/i);
    const ogTitle=page.text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const pageTitle=decodeHtml(ogTitle?.[1]||titleMatch?.[1]||'');
    const group=pageTitle;
    extractJsonLd(page.text,page.url,all);
    addMediaLinks(page.text,page.url,pageTitle,group,all);

    for(const link of extractPageLinks(page.text,page.url,base.origin)) {
      if(seen.size+queue.length>=MAX_QUEUE) break;
      if(queued.has(link)||seen.has(link)) continue;
      if(/\.(?:m3u8?|mpd)(?:$|[?#])/i.test(link) || likelyCatalogPage(link)) {
        queued.add(link); queue.push(link);
      }
    }
  }

  return dedupeItems(all);
}
