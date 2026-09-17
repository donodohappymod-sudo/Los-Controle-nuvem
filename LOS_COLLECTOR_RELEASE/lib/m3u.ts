export type Category = 'CANAIS' | 'FILMES' | 'SÉRIES' | 'OUTRO';
export type M3UItem = { title:string; url:string; group:string; logo:string; category:Category; attrs:Record<string,string> };
const attrRe = /([\w-]+)="([^"]*)"/g;
export function classify(group='', title=''): Category {
  const s = `${group} ${title}`.toLowerCase();
  if (/\b(series|série|series tv|temporada|season|epis[oó]dio)\b/.test(s)) return 'SÉRIES';
  if (/\b(filme|movie|cinema|filmes)\b/.test(s)) return 'FILMES';
  if (/\b(tv|canais?|live|ao vivo|news|esporte|sports|radio|rádio)\b/.test(s)) return 'CANAIS';
  return 'OUTRO';
}
export function parseM3U(text:string): M3UItem[] {
  const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim());
  const out:M3UItem[]=[]; let pending:any=null;
  for (const line of lines) {
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTINF')) {
      const comma = line.indexOf(','); const attrs:Record<string,string>={};
      for (const m of line.matchAll(attrRe)) attrs[m[1]]=m[2];
      pending = { title: comma >= 0 ? line.slice(comma+1).trim() : attrs['tvg-name'] || 'Sem título', group: attrs['group-title'] || '', logo: attrs['tvg-logo'] || '', attrs };
    } else if (!line.startsWith('#') && /^https?:\/\//i.test(line)) {
      const p = pending || {title:line,group:'',logo:'',attrs:{}};
      out.push({ ...p, url:line, category:classify(p.group,p.title) }); pending=null;
    }
  }
  return dedupe(out);
}
export function dedupe(items:M3UItem[]) { const seen=new Set<string>(); return items.filter(i=>{ const k=i.url.trim().toLowerCase(); if(!k || seen.has(k)) return false; seen.add(k); return true; }); }
export function buildM3U(items:M3UItem[]) {
  const lines=['#EXTM3U'];
  for (const i of dedupe(items)) lines.push(`#EXTINF:-1 tvg-logo="${escapeAttr(i.logo)}" group-title="${escapeAttr(i.group)}",${i.title}`, i.url);
  return lines.join('\n')+'\n';
}
function escapeAttr(s:string){return String(s||'').replaceAll('"','&quot;');}
export function isM3UText(text:string){ return /^\s*#EXTM3U\b/i.test(text) || /#EXTINF:/i.test(text); }
