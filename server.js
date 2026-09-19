const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),dns=require('node:dns').promises,{URL}=require('node:url'),{Pool}=require('pg'),{spawn}=require('node:child_process');
const PORT=Number(process.env.PORT||10000),ROOT=process.env.STORAGE_ROOT||path.join(process.cwd(),'storage');
fs.mkdirSync(ROOT,{recursive:true});
const secret=process.env.SESSION_SECRET||crypto.randomBytes(48).toString('base64url'); if(secret.length<32)throw Error('SESSION_SECRET deve ter pelo menos 32 caracteres');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const bootEmail=(process.env.BOOTSTRAP_ADMIN_EMAIL||'').trim().toLowerCase(),bootPassword=process.env.BOOTSTRAP_ADMIN_PASSWORD||''; if(process.env.NODE_ENV==='production'&&(!bootEmail||!bootPassword))throw Error('BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD são obrigatórios em produção');
const q=(t,p=[])=>pool.query(t,p),id=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const hash=p=>new Promise((resolve,reject)=>{const salt=crypto.randomBytes(16);crypto.scrypt(p,salt,64,(e,b)=>e?reject(e):resolve('scrypt$'+salt.toString('base64url')+'$'+b.toString('base64url')))});
const verify=async(p,h)=>{try{const a=String(h).split('$');if(a[0]!=='scrypt')return false;const salt=Buffer.from(a[1],'base64url'),want=Buffer.from(a[2],'base64url'),got=await new Promise((r,j)=>crypto.scrypt(p,salt,64,(e,b)=>e?j(e):r(b)));return want.length===got.length&&crypto.timingSafeEqual(want,got)}catch{return false}};
async function init(){
await q(`
CREATE TABLE IF NOT EXISTS users(id uuid primary key,email text unique not null,password_hash text not null,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS sessions(token_hash text primary key,user_id uuid references users(id) on delete cascade,expires_at timestamptz not null);
CREATE TABLE IF NOT EXISTS sources(id uuid primary key,name text not null,url text not null,type text not null,status text not null default 'active',created_at timestamptz not null default now(),last_collected_at timestamptz,last_verified_at timestamptz);
CREATE TABLE IF NOT EXISTS items(id uuid primary key,source_id uuid references sources(id) on delete cascade,type text not null,name text not null,original_name text,group_name text,category text,country text,language text,logo text,stream_url text,stream_type text,year int,genres text,description text,status text not null default 'unknown',last_verified_at timestamptz,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS series(id uuid primary key,source_id uuid references sources(id) on delete cascade,title text not null,original_title text,year int,genres text,cover_url text,description text,status text not null default 'unknown',metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS seasons(id uuid primary key,series_id uuid references series(id) on delete cascade,number int not null,unique(series_id,number));
CREATE TABLE IF NOT EXISTS episodes(id uuid primary key,series_id uuid references series(id) on delete cascade,season_id uuid references seasons(id) on delete cascade,source_id uuid references sources(id) on delete cascade,number int not null,title text not null,description text,duration text,stream_url text,status text not null default 'unknown',last_verified_at timestamptz,metadata jsonb not null default '{}'::jsonb);
CREATE TABLE IF NOT EXISTS verification_runs(id uuid primary key,kind text not null,total int not null,online int not null,errors int not null,timeouts int not null,results jsonb not null default '[]'::jsonb,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS generated_sources(id uuid primary key,name text not null,format text not null,content text not null,item_count int not null,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS collection_jobs(id uuid primary key,source_id uuid references sources(id) on delete cascade,status text not null,stage text not null default 'queued',progress int not null default 0,message text not null default '',pages_scanned int not null default 0,items_found int not null default 0,items_imported int not null default 0,error_count int not null default 0,result jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS studio_projects(id uuid primary key,title text not null,description text,cover_url text,background_url text,format text not null,duration int not null,status text not null,output_path text,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS generated_sources(id uuid primary key,name text not null,format text not null,content text not null,item_count int not null,created_at timestamptz not null default now());
`);
const alters=[
"ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin'",
"ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
"ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS user_id uuid",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'website'",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_count int NOT NULL DEFAULT 0",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_error text",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_collected_at timestamptz",
"ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_verified_at timestamptz",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS genre text NOT NULL DEFAULT ''",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS logo_path text NOT NULL DEFAULT ''",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS background_video_path text NOT NULL DEFAULT ''",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT ''",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS duration_seconds int NOT NULL DEFAULT 15",
"ALTER TABLE generated_sources ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE",
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE"
];
for(const sql of alters) await q(sql);
await q("UPDATE collection_jobs SET status='error',stage='stopped',message='Coleta interrompida pela reinicialização do serviço',updated_at=now() WHERE status IN ('queued','running')");
await q("CREATE INDEX IF NOT EXISTS items_source_idx ON items(source_id);CREATE INDEX IF NOT EXISTS items_type_idx ON items(type);CREATE INDEX IF NOT EXISTS episodes_source_idx ON episodes(source_id);CREATE INDEX IF NOT EXISTS series_source_idx ON series(source_id);");
const r=await q('SELECT id FROM users WHERE email=$1',[bootEmail]);
if(!r.rowCount) await q('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[id(),bootEmail,await hash(bootPassword)]);
else if(process.env.BOOTSTRAP_ADMIN_FORCE_RESET==='true'&&process.env.BOOTSTRAP_ADMIN_PASSWORD){
 await q('UPDATE users SET password_hash=$1,updated_at=now() WHERE email=$2',[await hash(bootPassword),bootEmail]);
 await q('DELETE FROM sessions WHERE user_id=$1',[r.rows[0].id]);
}
}
const send=(res,s,t,b,h={})=>{res.writeHead(s,{'content-type':t,'cache-control':'no-store',...h});res.end(b)},json=(res,s,o,h={})=>send(res,s,'application/json; charset=utf-8',JSON.stringify(o),h);
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>4e6)throw Error('Payload muito grande')}return s?JSON.parse(s):{}}
const cookie=req=>{const m=(req.headers.cookie||'').match(/(?:^|;\s*)los_session=([^;]+)/);return m&&m[1]},tokenHash=t=>crypto.createHash('sha256').update(t).digest('hex');
async function auth(req){const t=cookie(req);if(!t)return null;const r=await q('SELECT u.id,u.email,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[tokenHash(t)]);return r.rows[0]||null}

async function fetchText(rawUrl,options={}){
 const maxBytes=Math.min(20*1024*1024,Math.max(256*1024,Number(options.maxBytes)||8*1024*1024));
 const timeoutMs=Math.min(30000,Math.max(3000,Number(options.timeoutMs)||15000));
 let current=await safeUrl(rawUrl);
 const headers={'user-agent':'LOS-COLLECTOR/5.0 (+public-authorized-crawler)','accept':'text/html,application/xhtml+xml,application/xml,application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'};
 for(let hop=0;hop<6;hop++){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
   const r=await fetch(current,{redirect:'manual',signal:ac.signal,headers});
   if([301,302,303,307,308].includes(r.status)){
    const loc=r.headers.get('location');
    if(!loc)throw Error('Redirecionamento sem destino');
    current=await safeUrl(new URL(loc,current));
    continue;
   }
   if(!r.ok)throw Error('HTTP '+r.status);
   const len=Number(r.headers.get('content-length')||0);
   if(len&&len>maxBytes)throw Error('Resposta maior que o limite de '+Math.round(maxBytes/1024/1024)+' MB');
   const reader=r.body?.getReader();
   if(!reader){const text=await r.text();if(Buffer.byteLength(text,'utf8')>maxBytes)throw Error('Resposta maior que o limite');return {text,url:current.toString(),contentType:r.headers.get('content-type')||''};}
   const chunks=[];let total=0;
   while(true){
    const part=await reader.read();if(part.done)break;
    total+=part.value.byteLength;if(total>maxBytes){try{await reader.cancel()}catch{}throw Error('Resposta maior que o limite de '+Math.round(maxBytes/1024/1024)+' MB')}
    chunks.push(Buffer.from(part.value));
   }
   return {text:Buffer.concat(chunks).toString('utf8'),url:current.toString(),contentType:r.headers.get('content-type')||''};
  }catch(e){
   if(e.name==='AbortError')throw Error('Timeout ao acessar a página');
   throw e;
  }finally{clearTimeout(timer)}
 }
 throw Error('Muitos redirecionamentos');
}

async function safeUrl(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw Error('Somente HTTP/HTTPS');const h=u.hostname.toLowerCase();if(h==='localhost'||h.endsWith('.local')||h.endsWith('.internal'))throw Error('Destino privado bloqueado');const ips=await dns.lookup(h,{all:true}).catch(()=>[]);for(const x of ips){const ip=x.address;if(/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)||ip==='::1'||/^f[cd]/i.test(ip)||/^fe80:/i.test(ip))throw Error('Destino privado bloqueado')}return u}
function attrs(s){
 const o={};
 for(const m of String(s||'').matchAll(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^,\s]+))/g)) o[m[1]]=(m[3]??m[4]??m[5]??'').trim();
 return o;
}
function absoluteUrl(raw,base){
 try{return new URL(String(raw).trim().replaceAll('\\/','/'),base).toString()}catch{return ''}
}
function streamNameFromUrl(raw,fallback='Stream detectado'){
 try{
  const u=new URL(raw),n=decodeURIComponent(u.pathname.split('/').pop()||'').replace(/[-_]+/g,' ').replace(/\.[^.]+$/,'').trim();
  return n||fallback;
 }catch{return fallback}
}
function parseM3U(text,baseUrl='',sourceUrl=''){
 const lines=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/);
 const out=[],seen=new Set();let pending=null,master=null,masterCount=0,hasTarget=false,hasSegments=false;
 for(const rawLine of lines){
  const line=rawLine.trim();
  if(!line) continue;
  if(/^#EXT-X-TARGETDURATION:/i.test(line)) hasTarget=true;
  if(/^#EXTINF:/i.test(line)){
   const at=attrs(line),name=line.slice(line.indexOf(',')+1).trim()||at['tvg-name']||'Sem nome';
   pending={at,name};continue;
  }
  if(/^#EXT-X-STREAM-INF:/i.test(line)){master=attrs(line.slice(line.indexOf(':')+1));masterCount++;continue}
  if(/^#EXT-X-MEDIA:/i.test(line)){
   const at=attrs(line.slice(line.indexOf(':')+1));
   if(at.URI){
    const u=absoluteUrl(at.URI,baseUrl);
    if(u&&!seen.has(u)){seen.add(u);out.push({type:'channel',name:at.NAME||at['GROUP-ID']||streamNameFromUrl(u),originalName:at.NAME||'',group:at['GROUP-ID']||'',logo:'',streamUrl:u,status:'unknown',streamType:'m3u8',metadata:{discoveredFrom:'m3u8-rendition',language:at.LANGUAGE||'',sourceUrl}});
   }
  }
  continue;
 }
 if(line.startsWith('#')) continue;
 const url=absoluteUrl(line,baseUrl);if(!url)continue;
 if(master){
  if(!seen.has(url)){seen.add(url);const label=master.NAME||((master.RESOLUTION||master.BANDWIDTH)?['HLS',master.RESOLUTION||'',master.BANDWIDTH?Math.round(Number(master.BANDWIDTH)/1000)+'kbps':''].filter(Boolean).join(' '):streamNameFromUrl(url));out.push({type:'channel',name:label,originalName:label,group:'',logo:'',streamUrl:url,status:'unknown',streamType:'m3u8',metadata:{discoveredFrom:'m3u8-master',bandwidth:master.BANDWIDTH||'',resolution:master.RESOLUTION||'',codecs:master.CODECS||'',sourceUrl}})}
  master=null;continue;
 }
 if(pending){
  const at=pending.at,name=pending.name,z=((at.type||'')+' '+(at['group-title']||'')+' '+name).toLowerCase();
  const type=/movie|filme|vod/.test(z)?'movie':/episode|epis[oó]dio|season|temporada/.test(z)?'episode':'channel';
  if(!seen.has(url)){seen.add(url);out.push({type,name,originalName:name,group:at['group-title']||'',logo:at['tvg-logo']||'',streamUrl:url,status:'unknown',streamType:/\.m3u8(?:$|[?#])/i.test(url)?'m3u8':'stream',metadata:{tvgId:at['tvg-id']||'',language:at['tvg-language']||'',channelId:at['tvg-chno']||'',sourceUrl}})}
  pending=null;continue;
 }
 hasSegments=true;
 }
 const looksLikeMediaPlaylist=hasTarget||hasSegments&&/#EXT-X-MEDIA-SEQUENCE|#EXT-X-ENDLIST/i.test(String(text));
 if(!out.length&&looksLikeMediaPlaylist&&sourceUrl){
  out.push({type:'channel',name:streamNameFromUrl(sourceUrl,'Stream M3U8'),originalName:streamNameFromUrl(sourceUrl,'Stream M3U8'),group:'',logo:'',streamUrl:sourceUrl,status:'unknown',streamType:'m3u8',metadata:{discoveredFrom:'m3u8-media-playlist',sourceUrl}});
 }
 return {items:out,isMaster:masterCount>0,isMedia:looksLikeMediaPlaylist};
}
function classifyMediaUrl(u,meta=''){
 const z=(u+' '+meta).toLowerCase();
 if(/\.(mpd)(?:$|[?#])/.test(z))return 'stream';
 if(/\.(m3u8?|m3u)(?:$|[?#])|[?&](?:format|type)=(?:m3u8?|m3u)/.test(z))return 'm3u8';
 if(/\.(mp4|m4v|webm|mov|mkv|ts)(?:$|[?#])/.test(z))return 'stream';
 return '';
}
function classifyContent(name,url,meta=''){
 const z=(name+' '+url+' '+meta).toLowerCase();
 if(/episode|epis[oó]dio|season[-_ ]?\d|temporada[-_ ]?\d|s\d{1,2}e\d{1,3}/.test(z))return 'episode';
 if(/movie|filme|movies|filmes|vod|on[-_ ]?demand/.test(z))return 'movie';
 return 'channel';
}

function stripHtml(v=''){return String(v).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}
function htmlEntity(v=''){return String(v).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&nbsp;/gi,' ')}
function normalizePageUrl(raw,baseUrl){
 try{
  const u=new URL(String(raw).trim().replaceAll('\\/','/'),baseUrl),b=new URL(baseUrl);
  if(!['http:','https:'].includes(u.protocol)||u.hostname!==b.hostname)return '';
  u.hash='';
  for(const k of [...u.searchParams.keys()])if(/^utm_|^fbclid$|^gclid$|^ref$/i.test(k))u.searchParams.delete(k);
  if(/\.(?:jpg|jpeg|png|gif|svg|webp|css|js|ico|woff2?|pdf|zip|rar|xml|json)(?:$|[?#])/i.test(u.pathname))return '';
  return u.toString();
 }catch{return ''}
}
function pageMeta(text,url){
 const src=String(text||''),title=(src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'').trim();
 const ogTitle=src.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]||'';
 const description=src.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1]||'';
 const image=src.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]||src.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i)?.[1]||'';
 const clean=htmlEntity(stripHtml(ogTitle||title)).replace(/\s+-\s+Animes Online.*$/i,'').replace(/\s+Todos os Episodios Online.*$/i,'').trim();
 const year=Number(src.match(/\b(19|20)\d{2}\b/)?.[0]||0)||null;
 const genres=[...src.matchAll(/href=["']([^"']*\/genero\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>htmlEntity(stripHtml(m[2]))).filter(Boolean).slice(0,20);
 const p=new URL(url).pathname.toLowerCase();
 let type='catalog';
 if(/\/episodio\//.test(p))type='episode';
 else if(/\/anime\//.test(p))type='series';
 else if(/\/filme\//.test(p)||/\/movie\//.test(p))type='movie';
 const ep=(src+' '+url).match(/\bepis[oó]dio\s*[-#:]?\s*(\d{1,4})\b/i)?.[1];
 const season=(src+' '+url).match(/\btemporada\s*[-#:]?\s*(\d{1,3})\b/i)?.[1];
 let seriesUrl='';
 const sm=src.match(/href=["']([^"']*\/anime\/[^"']+)["'][^>]*>/i);if(sm)seriesUrl=normalizePageUrl(sm[1],url);
 let seriesTitle='';
 if(seriesUrl){try{seriesTitle=decodeURIComponent(new URL(seriesUrl).pathname.split('/').filter(Boolean).pop()||'').replace(/[-_]+/g,' ').replace(/\b\w/g,x=>x.toUpperCase())}catch{}}
 if(type==='episode'&&!seriesTitle){
  const m=clean.match(/^(.*?)\s+epis[oó]dio\s+\d+/i);if(m)seriesTitle=m[1].trim();
 }
 const media=[];
 for(const m of src.matchAll(/(?:src|data-src|data-url|href)=["']([^"']+)["']/gi)){
  const u=absoluteUrl(m[1],url);if(u&&classifyMediaUrl(u,m[0]))media.push(u);
 }
 return {title:clean||streamNameFromUrl(url,'Conteúdo'),description:htmlEntity(stripHtml(description)),image:absoluteUrl(image,url),year,genres:[...new Set(genres)],type,episodeNumber:Number(ep||0)||null,seasonNumber:Number(season||1)||1,seriesUrl,seriesTitle:seriesTitle||clean.replace(/\s+epis[oó]dio.*$/i,'').trim(),media:[...new Set(media)]};
}
function htmlItems(text,baseUrl){
 const src=String(text||'').replaceAll('\\/','/').replace(/&amp;/gi,'&'),out=[],seen=new Set(),pages=[],playerPages=[],meta=pageMeta(src,baseUrl);
 const addPage=(raw,priority=0)=>{
  const u=normalizePageUrl(raw,baseUrl);if(!u)return;
  const score=priority||(/\\/(anime|episodio|temporada|genero|dublado|legendado|lancamento|ano|page|pagina)\\b/i.test(new URL(u).pathname)?5:1);
  pages.push({url:u,score});
 };
 const addPlayer=(raw,kind='iframe')=>{
  const u=absoluteUrl(raw,baseUrl);if(!u||!/^https?:/i.test(u))return;
  try{
   const x=new URL(u);
   if(/\\.(?:jpg|jpeg|png|gif|svg|webp|css|js|ico|woff2?|pdf|zip|rar|xml|json)(?:$|[?#])/i.test(x.pathname))return;
   if(!playerPages.some(v=>v===u)&&playerPages.length<300)playerPages.push(u);
  }catch{}
 };
 const addMedia=(raw,metaText='',kind='website')=>{
  const u=absoluteUrl(raw,baseUrl);if(!u||seen.has(u)||seen.size>=5000||!/^https?:/i.test(u))return;
  const streamType=classifyMediaUrl(u,metaText);
  if(!streamType)return;
  seen.add(u);
  out.push({type:classifyContent(meta.title,u,metaText),name:streamNameFromUrl(u,'Conteúdo encontrado'),originalName:meta.title||'',group:'',logo:meta.image||'',streamUrl:u,status:'unknown',streamType,metadata:{discoveredFrom:kind,context:metaText.slice(0,500),sourcePage:baseUrl}});
 };
 for(const m of src.matchAll(/(?:href|src|data-src|data-url|data-href|data-player|data-video|data-embed|content)=["']([^"']+)["']/gi)){
  const raw=m[1],tag=m[0].toLowerCase();
  if(/iframe|data-player|data-video|data-embed/.test(tag))addPlayer(raw,'player');
  if(/href|data-href/.test(tag))addPage(raw,/\\/(?:anime|episodio|temporada|genero|dublado|legendado|lancamento|ano|page|pagina)\\//i.test(raw)?8:1);
  addMedia(raw,tag,'html-attribute');
 }
 for(const m of src.matchAll(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi))addPlayer(m[1],'iframe');
 for(const m of src.matchAll(/(?:player|embed|iframe|video|source|file|src)\\s*[:=]\\s*["'](https?:[^"']+)["']/gi))addPlayer(m[2]||m[1],'script-player');
 for(const m of src.matchAll(/https?:\\/\\/[^\\s"'<>\\)]+/gi)){addMedia(m[0],'absolute-url','html');if(/(?:embed|player|iframe|video|stream|m3u8)/i.test(m[0]))addPlayer(m[0],'absolute-player')}
 for(const m of src.matchAll(/(?:^|["'\\s])(\\/?[^"'\\s<>]+\\.(?:m3u8?|m3u|mp4|m4v|webm|mov|mkv|ts|mpd)(?:\\?[^"'\\s<>]*)?)/gi))addMedia(m[1],'extension','embedded-url');
 for(const m of src.matchAll(/url\\(\\s*["']?([^"')]+)["']?\\s*\\)/gi))addMedia(m[1],'css-url','css');
 if(meta.media.length)for(const u of meta.media)addMedia(u,'page-media','metadata');
 const catalogType=meta.type;
 if(catalogType==='series'||catalogType==='episode'||catalogType==='movie'){
  out.push({type:catalogType,name:meta.title,originalName:meta.title,group:meta.genres.join(', '),logo:meta.image,streamUrl:meta.media[0]||'',status:'unknown',streamType:meta.media[0]?classifyMediaUrl(meta.media[0],''):'catalog',metadata:{discoveredFrom:'catalog-page',sourcePage:baseUrl,description:meta.description,year:meta.year,genres:meta.genres,episodeNumber:meta.episodeNumber,seasonNumber:meta.seasonNumber,seriesUrl:meta.seriesUrl,seriesTitle:meta.seriesTitle}});
 }
 return {items:out,pages:[...new Map(pages.map(x=>[x.url,x])).values()].sort((a,b)=>b.score-a.score).map(x=>x.url),playerPages:[...new Set(playerPages)],meta};
}
async function crawlWebsite(rootUrl,options={}){
 const maxPages=Math.min(2500,Math.max(20,Number(options.maxPages)||1200)),maxDepth=Math.min(6,Math.max(0,Number(options.maxDepth)||5)),concurrency=Math.min(8,Math.max(2,Number(options.concurrency)||6));
 const root=new URL(rootUrl),queue=[{url:root.toString(),depth:0,kind:'site'}],queued=new Set([root.toString()]),visited=new Set(),items=[],seenItems=new Set(),playlists=new Set(),errors=[],playerQueued=new Set();
 const emit=typeof options.onProgress==='function'?options.onProgress:()=>{};
 let lastEmit=0;
 const addItems=(arr)=>{for(const x of arr){const key=(x.type||'')+'|'+(x.streamUrl||x.name||'').toLowerCase()+'|'+(x.metadata?.sourcePage||'');if(seenItems.has(key))continue;seenItems.add(key);items.push(x);if(x.streamType==='m3u8')playlists.add(x.streamUrl)}};
 async function worker(){
  while(true){
   const job=queue.shift();if(!job)break;
   if(visited.has(job.url)||job.depth>maxDepth)continue;
   visited.add(job.url);
   try{
    const r=await fetchText(job.url),parsed=htmlItems(r.text,r.url);
    addItems(parsed.items);
    for(const p of parsed.pages){
     if(job.kind!=='site')continue;
     if(visited.has(p)||queued.has(p)||visited.size+queue.length>=maxPages)continue;
     queued.add(p);queue.push({url:p,depth:job.depth+1,kind:'site'});
    }
    for(const p of parsed.playerPages||[]){
     if(visited.has(p)||playerQueued.has(p)||visited.size+queue.length>=maxPages)continue;
     try{await safeUrl(p)}catch{continue}
     playerQueued.add(p);queued.add(p);queue.push({url:p,depth:Math.min(maxDepth,job.depth+1),kind:'player'});
    }
   }catch(e){if(errors.length<200)errors.push({url:job.url,error:e.message})}
   const ts=Date.now();if(ts-lastEmit>500){lastEmit=ts;emit({pagesScanned:visited.size,pagesQueued:queued.size,itemsFound:items.length,errors:errors.length,message:'Varredura: '+visited.size+' página(s), '+items.length+' conteúdo(s) encontrado(s).'});}
  }
 }
 await Promise.all(Array.from({length:concurrency},worker));
 for(const u of playlists.slice(0,500)){
  try{const r=await fetchText(u),parsed=parseM3U(r.text,r.url,u);addItems(parsed.items)}
  catch(e){if(errors.length<200)errors.push({url:u,error:'Playlist: '+e.message})}
 }
 emit({pagesScanned:visited.size,pagesQueued:queued.size,itemsFound:items.length,errors:errors.length,message:'Varredura concluída.'});
 const finalItems=items.slice(0,20000);
 const counts=finalItems.reduce((a,x)=>{a[x.type]=(a[x.type]||0)+1;return a}, {});
 return {kind:'website',sourceUrl:rootUrl,items:finalItems,pagesScanned:visited.size,pagesQueued:queued.size,playlistsFound:playlists.size,playerPagesFound:playerQueued.size,errors,discovered:finalItems.length,counts,message:'Varredura concluída: '+visited.size+' página(s), '+playlists.size+' playlist(s), '+playerQueued.size+' player(s) e '+finalItems.length+' conteúdo(s) identificado(s).'};
}
async function fetchSource(raw,requestedType='website',onProgress=()=>{}){
 const sourceUrl=String(raw||'').trim();if(!sourceUrl)throw Error('URL da fonte é obrigatória');
 const type=String(requestedType||'auto').toLowerCase(),root=await fetchText(sourceUrl),text=root.text||'';
 if(type==='media'){
  const st=classifyMediaUrl(root.url,root.contentType)||'stream';
  return {kind:'media',sourceUrl:root.url,items:[{type:'channel',name:streamNameFromUrl(root.url,'Stream'),originalName:streamNameFromUrl(root.url,'Stream'),group:'',logo:'',streamUrl:root.url,status:'unknown',streamType:st,metadata:{discoveredFrom:'direct-media'}}],discovered:1,pagesScanned:1,errors:[],message:'Mídia direta identificada.'};
 }
 const detectedM3U=/\\.(?:m3u8?|m3u)(?:$|[?#])/i.test(root.url)||/mpegurl|x-mpegurl/i.test(root.contentType)||/^\\s*#EXTM3U/i.test(text)||/^\\s*#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/i.test(text);
 if(type==='auto'||type==='m3u'||type==='m3u8'||detectedM3U){
  const parsed=parseM3U(text,root.url,root.url);
  if(parsed.items.length)return {kind:'m3u',sourceUrl:root.url,items:parsed.items,discovered:parsed.items.length,playlists:[root.url],pagesScanned:1,errors:[],message:parsed.isMaster?'Playlist HLS mestre analisada.':parsed.isMedia?'Stream HLS identificado.':'Playlist M3U/M3U8 analisada.'};
  if(type==='m3u8'||/m3u8/i.test(root.url)||/mpegurl|x-mpegurl/i.test(root.contentType))return {kind:'m3u8',sourceUrl:root.url,items:[{type:'channel',name:streamNameFromUrl(root.url,'Stream M3U8'),originalName:streamNameFromUrl(root.url,'Stream M3U8'),group:'',logo:'',streamUrl:root.url,status:'unknown',streamType:'m3u8',metadata:{discoveredFrom:'direct-m3u8'}}],discovered:1,playlists:[root.url],pagesScanned:1,errors:[],message:'Stream M3U8 direto identificado.'};
 }
 return crawlWebsite(root.url,{maxPages:Math.min(2500,Number(process.env.CRAWLER_MAX_PAGES)||1200),maxDepth:Math.min(6,Number(process.env.CRAWLER_MAX_DEPTH)||5),concurrency:6,onProgress});
}


async function checkUrl(raw){const started=Date.now();try{const u=await safeUrl(raw),ac=new AbortController(),timer=setTimeout(()=>ac.abort(),12000);let r;try{r=await fetch(u,{method:'HEAD',redirect:'manual',signal:ac.signal,headers:{'user-agent':'LOS-COLLECTOR-CHECK/4.0'}});if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');if(loc){const target=new URL(loc,u);await safeUrl(target);r=await fetch(target,{method:'HEAD',redirect:'manual',signal:ac.signal,headers:{'user-agent':'LOS-COLLECTOR-CHECK/4.0'}})}}if(r.status===405||r.status===501)r=await fetch(u,{method:'GET',redirect:'manual',signal:ac.signal,headers:{range:'bytes=0-0','user-agent':'LOS-COLLECTOR-CHECK/4.0'}})}finally{clearTimeout(timer)}return {status:r.ok?'online':'error',httpStatus:r.status,responseMs:Date.now()-started,reason:r.ok?'OK':'HTTP '+r.status}}catch(e){return {status:e.name==='AbortError'?'timeout':'error',responseMs:Date.now()-started,reason:e.name==='AbortError'?'Timeout':e.message}}}

async function importItems(sourceId,items){
 const summary={received:items.length,imported:0,failed:0,series:0,episodes:0,channels:0,movies:0,errors:[]};
 const seriesCache=new Map();
 for(const x of items){
  try{
   const type=x.type||'channel',md=x.metadata||{};
   if(type==='series'){
    const key=String(x.name||'Sem título').trim().toLowerCase();
    let sr=seriesCache.get(key);
    if(!sr){sr=await q('SELECT id FROM series WHERE source_id=$1 AND lower(title)=lower($2) LIMIT 1',[sourceId,x.name||'Sem título']);if(sr.rowCount)seriesCache.set(key,sr.rows[0].id)}
    if(!sr){const sid=id();await q('INSERT INTO series(id,source_id,title,year,genres,cover_url,description,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[sid,sourceId,x.name||'Sem título',md.year||null,Array.isArray(md.genres)?md.genres.join(', '):x.group||'',x.logo||'',md.description||'',x.status||'unknown',JSON.stringify(md)]);seriesCache.set(key,sid);sr=sid}
    summary.series++;summary.imported++;continue;
   }
   if(type==='episode'){
    const seriesTitle=String(md.seriesTitle||x.originalName||x.name||'Série desconhecida').replace(/\s+epis[oó]dio.*$/i,'').trim()||'Série desconhecida';
    const skey=seriesTitle.toLowerCase();
    let seriesId=seriesCache.get(skey);
    if(!seriesId){const sr=await q('SELECT id FROM series WHERE source_id=$1 AND lower(title)=lower($2) LIMIT 1',[sourceId,seriesTitle]);if(sr.rowCount)seriesId=sr.rows[0].id}
    if(!seriesId){seriesId=id();await q('INSERT INTO series(id,source_id,title,status,metadata) VALUES($1,$2,$3,$4,$5)',[seriesId,sourceId,seriesTitle,'unknown',JSON.stringify({discoveredFrom:'episode-page'})]);}
    seriesCache.set(skey,seriesId);
    const seasonNo=Math.max(1,Number(md.seasonNumber)||1),epNo=Math.max(1,Number(md.episodeNumber)||1);
    let ss=await q('SELECT id FROM seasons WHERE series_id=$1 AND number=$2 LIMIT 1',[seriesId,seasonNo]);
    let seasonId=ss.rowCount?ss.rows[0].id:id();
    if(!ss.rowCount)await q('INSERT INTO seasons(id,series_id,number) VALUES($1,$2,$3)',[seasonId,seriesId,seasonNo]);
    const dup=await q('SELECT id FROM episodes WHERE source_id=$1 AND series_id=$2 AND season_id=$3 AND number=$4 LIMIT 1',[sourceId,seriesId,seasonId,epNo]);
    if(!dup.rowCount)await q('INSERT INTO episodes(id,series_id,season_id,source_id,number,title,description,duration,stream_url,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id(),seriesId,seasonId,sourceId,epNo,x.name||('Episódio '+epNo),md.description||'',md.duration||'',x.streamUrl||'',x.status||'unknown',JSON.stringify(md)]);
    summary.episodes++;summary.imported++;continue;
   }
   if(!x.streamUrl)throw Error('Item sem URL de mídia');
   await safeUrl(x.streamUrl);
   const dup=await q('SELECT id FROM items WHERE source_id=$1 AND lower(stream_url)=lower($2) LIMIT 1',[sourceId,x.streamUrl]);
   if(dup.rowCount)continue;
   await q('INSERT INTO items(id,source_id,type,name,original_name,group_name,logo,stream_url,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id(),sourceId,type,x.name||'Sem nome',x.originalName||x.name||'',x.group||'',x.logo||'',x.streamUrl,x.status||'unknown',JSON.stringify(md)]);
   summary[type==='movie'?'movies':'channels']++;summary.imported++;
  }catch(e){summary.failed++;if(summary.errors.length<30)summary.errors.push({name:x.name||'Sem nome',url:x.streamUrl||'',error:e.message})}
 }
 return summary
}

function m3u(items){return '#EXTM3U\n'+items.map(x=>'#EXTINF:-1'+(x.group?' group-title="'+String(x.group).replaceAll('"','&quot;')+'"':'')+(x.logo?' tvg-logo="'+String(x.logo).replaceAll('"','&quot;')+'"':'')+','+(x.name||x.title||'Sem nome')+'\n'+(x.streamUrl||'')).join('\n')}
async function library(uid){const [a,s,e]=await Promise.all([q('SELECT i.id,i.source_id,i.type,i.name,i.original_name AS "originalName",i.group_name AS "group",i.category,i.country,i.language,i.logo,i.stream_url AS "streamUrl",i.stream_type AS "streamType",i.year,i.genres,i.description,i.status,i.last_verified_at AS "lastVerifiedAt",i.metadata FROM items i JOIN sources so ON so.id=i.source_id WHERE so.user_id=$1 ORDER BY i.created_at DESC LIMIT 5000',[uid]),q('SELECT x.id,x.source_id,x.title,x.original_title AS "originalTitle",x.year,x.genres,x.cover_url AS "coverUrl",x.description,x.status,x.metadata FROM series x JOIN sources so ON so.id=x.source_id WHERE so.user_id=$1 ORDER BY x.created_at DESC LIMIT 2000',[uid]),q('SELECT e.id,e.series_id,e.source_id,e.season_id,e.number,e.title,e.description,e.duration,e.stream_url AS "streamUrl",e.status,e.last_verified_at AS "lastVerifiedAt",e.metadata FROM episodes e JOIN sources so ON so.id=e.source_id WHERE so.user_id=$1 ORDER BY e.number LIMIT 5000',[uid])]);return {items:a.rows,series:s.rows,episodes:e.rows}}
async function dashboard(uid){const sql=['SELECT count(*)::int n FROM sources WHERE user_id=$1',"SELECT count(*)::int n FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.type='channel'","SELECT count(*)::int n FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.type='movie'","SELECT count(*)::int n FROM series s JOIN sources so ON so.id=s.source_id WHERE so.user_id=$1","SELECT count(*)::int n FROM episodes e JOIN sources so ON so.id=e.source_id WHERE so.user_id=$1","SELECT count(*)::int n FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.status='online'","SELECT count(*)::int n FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.status IN ('error','timeout')"];const r=await Promise.all(sql.map(x=>q(x,[uid])));const v=r.map(x=>x.rows[0].n);return {sources:v[0],channels:v[1],movies:v[2],series:v[3],episodes:v[4],online:v[5],errors:v[6]}}

async function startCollection(sourceId){
 const jobId=id();
 await q("INSERT INTO collection_jobs(id,source_id,status,stage,message) VALUES($1,$2,'queued','starting','Preparando varredura...')",[jobId,sourceId]);
 (async()=>{
  try{
   const sr=await q('SELECT * FROM sources WHERE id=$1',[sourceId]); if(!sr.rowCount)throw Error('Fonte não encontrada');
   const src=sr.rows[0];
   await q("UPDATE collection_jobs SET status='running',stage='fetching',progress=5,message='Conectando à fonte...',updated_at=now() WHERE id=$1",[jobId]);
   console.log('[COLLECTOR] start',jobId,src.url);
   const c=await fetchSource(src.url,src.type,p=>q("UPDATE collection_jobs SET stage='crawling',progress=$2,message=$3,pages_scanned=$4,items_found=$5,error_count=$6,updated_at=now() WHERE id=$1",[jobId,Math.min(70,5+Math.min(65,Math.floor((p.pagesScanned/Math.max(1,p.pagesQueued))*65))),p.message,p.pagesScanned,p.itemsFound,p.errors]).catch(()=>{}));
   await q("UPDATE collection_jobs SET stage='importing',progress=75,message=$2,pages_scanned=$3,items_found=$4,error_count=$5,updated_at=now() WHERE id=$1",[jobId,c.message||'Importando conteúdo...',c.pagesScanned||1,c.items?.length||0,c.errors?.length||0]);
   const summary=await importItems(sourceId,c.items||[]);
   const result={...c,summary};
   await q("UPDATE collection_jobs SET status='done',stage='complete',progress=100,message=$2,pages_scanned=$3,items_found=$4,items_imported=$5,error_count=$6,result=$7,updated_at=now() WHERE id=$1",[jobId,(c.message||'Coleta concluída.')+' '+summary.series+' séries, '+summary.episodes+' episódios, '+summary.channels+' canais, '+summary.movies+' filmes.',c.pagesScanned||1,c.items?.length||0,summary.imported,summary.failed+(c.errors?.length||0),JSON.stringify(result)]);
   await q("UPDATE sources SET last_collected_at=now(),content_count=$2,last_error=$3,status=$4,updated_at=now() WHERE id=$1",[sourceId,summary.imported,summary.failed?JSON.stringify(summary.errors.slice(0,5)):'',summary.imported||c.items.length?'active':'warning']);
   console.log('[COLLECTOR] done',jobId,summary.imported,'/',summary.received);
  }catch(e){
   console.error('[COLLECTOR] failed',jobId,e);
   await q("UPDATE collection_jobs SET status='error',stage='error',message=$2,error_count=error_count+1,updated_at=now() WHERE id=$1",[jobId,e.message]);
   await q("UPDATE sources SET status='error',last_error=$2,updated_at=now() WHERE id=$1",[sourceId,e.message]);
  }
 })();
 return jobId;
}
async function latestJob(sourceId){const r=await q("SELECT id,source_id,status,stage,progress,message,pages_scanned AS \"pagesScanned\",items_found AS \"itemsFound\",items_imported AS \"itemsImported\",error_count AS \"errorCount\",result,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM collection_jobs WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1",[sourceId]);return r.rows[0]||null}

async function aiDiagnose(){
 const checks=[];
 const add=(name,ok,detail)=>checks.push({name,ok:Boolean(ok),detail:String(detail||'')});
 try{await q('SELECT 1');add('PostgreSQL',true,'Conexão com banco funcionando')}catch(e){add('PostgreSQL',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM sources");add('Fontes',true,r.rows[0].n+' fonte(s) cadastrada(s)')}catch(e){add('Fontes',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM collection_jobs WHERE status IN ('queued','running')");add('Jobs de coleta',true,r.rows[0].n+' job(s) ativo(s)')}catch(e){add('Jobs de coleta',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM items");add('Biblioteca',true,r.rows[0].n+' item(ns) importado(s)')}catch(e){add('Biblioteca',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM series");add('Séries',true,r.rows[0].n+' série(s)')}catch(e){add('Séries',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM episodes");add('Episódios',true,r.rows[0].n+' episódio(s)')}catch(e){add('Episódios',false,e.message)}
 try{const r=await q("SELECT count(*)::int AS n FROM generated_sources");add('Fontes geradas',true,r.rows[0].n+' fonte(s)')}catch(e){add('Fontes geradas',false,e.message)}
 const openaiConfigured=Boolean(process.env.OPENAI_API_KEY);
 const codexConfigured=Boolean(process.env.CODEX_API_KEY);
 let ai=null;
 if(openaiConfigured){
  try{
   const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-6-astra',input:'Analise estes testes do LOS COLLECTOR e responda em português com: 1) falhas reais, 2) causa provável, 3) próximos testes. Não invente fatos. Dados: '+JSON.stringify(checks)})});
   const data=await response.json();
   if(!response.ok)throw Error(data.error?.message||('OpenAI HTTP '+response.status));
   ai=data.output_text||data.output?.map(x=>x.content?.map(y=>y.text||'').join('')).join('')||'';
  }catch(e){ai='GPT configurado, mas a análise falhou: '+e.message}
 }
 return {ok:checks.every(x=>x.ok),checks,integrations:{gpt:openaiConfigured,codex:codexConfigured},ai};
}
async function api(req,res,u){const p=u.pathname;
if(req.method==='GET'&&p==='/api/health'){try{await q('SELECT 1');return json(res,200,{ok:true,database:true,time:now()})}catch(e){return json(res,503,{ok:false,database:false,error:e.message})}}
if(req.method==='POST'&&p==='/api/auth/login'){const b=await body(req),email=String(b.email||'').trim().toLowerCase(),pw=String(b.password||''),r=await q('SELECT id,email,password_hash FROM users WHERE email=$1',[email]);if(!r.rowCount||!(await verify(pw,r.rows[0].password_hash)))return json(res,401,{error:'Email ou senha inválidos'});const raw=crypto.randomBytes(32).toString('base64url');await q("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[tokenHash(raw),r.rows[0].id]);return json(res,200,{ok:true},{'set-cookie':'los_session='+raw+'; HttpOnly; Path=/; SameSite=Lax; '+(process.env.NODE_ENV==='production'?'Secure; ':'')+'Max-Age=2592000'})}
if(req.method==='POST'&&p==='/api/auth/logout'){const t=cookie(req);if(t)await q('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(t)]);return json(res,200,{ok:true},{'set-cookie':'los_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'})}
const uo=await auth(req);if(!uo)return json(res,401,{error:'UNAUTHORIZED'});
if(req.method==='GET'&&p==='/api/auth/me')return json(res,200,{user:{id:uo.id,email:uo.email}});
if(req.method==='POST'&&p==='/api/auth/change-password'){const b=await body(req),old=String(b.currentPassword||''),nw=String(b.newPassword||'');if(nw.length<10)return json(res,400,{error:'Nova senha: mínimo de 10 caracteres'});const r=await q('SELECT password_hash FROM users WHERE id=$1',[uo.id]);if(!(await verify(old,r.rows[0].password_hash)))return json(res,400,{error:'Senha atual inválida'});await q('UPDATE users SET password_hash=$1 WHERE id=$2',[await hash(nw),uo.id]);await q('DELETE FROM sessions WHERE user_id=$1',[uo.id]);return json(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/ai/diagnostics')return json(res,200,await aiDiagnose());
if(req.method==='GET'&&p==='/api/dashboard')return json(res,200,await dashboard(uo.id));
if(req.method==='GET'&&p==='/api/sources'){const r=await q("SELECT s.*,(SELECT count(*) FROM items i WHERE i.source_id=s.id AND i.type='channel')::int channels,(SELECT count(*) FROM items i WHERE i.source_id=s.id AND i.type='movie')::int movies,(SELECT count(*) FROM series x WHERE x.source_id=s.id)::int series,(SELECT count(*) FROM episodes e WHERE e.source_id=s.id)::int episodes FROM sources s WHERE s.user_id=$1 ORDER BY created_at DESC",[uo.id]);return json(res,200,{items:r.rows})}
if(req.method==='POST'&&p==='/api/sources'){
 const b=await body(req),name=String(b.name||'').trim(),url=String(b.url||'').trim(),type=String(b.type||'auto').toLowerCase(); console.log('[SOURCE] request',uo.email,name,url,type,'collectNow=',!!b.collectNow);
 if(!name||!url)return json(res,400,{error:'Nome e URL são obrigatórios'});
 await safeUrl(url);
 console.log('[SOURCE] url validated',url);
 const sid=id();
 await q('INSERT INTO sources(id,user_id,name,url,type) VALUES($1,$2,$3,$4,$5)',[sid,uo.id,name,url,type]); console.log('[SOURCE] created',sid);
 if(b.collectNow){
  const jobId=await startCollection(sid); console.log('[SOURCE] collection queued',sid,jobId); return json(res,201,{source:{id:sid,name,url,type},jobId});
 }
 return json(res,201,{source:{id:sid,name,url,type}});
}
if(req.method==='POST'&&p.match(/^\/api\/sources\/[^/]+\/collect$/)){
 const sid=p.split('/')[3],r=await q('SELECT id FROM sources WHERE id=$1 AND user_id=$2',[sid,uo.id]);
 if(!r.rowCount)return json(res,404,{error:'Fonte não encontrada'});
 const jobId=await startCollection(sid);
 return json(res,202,{jobId});
}
if(req.method==='GET'&&p.match(/^\/api\/sources\/[^/]+\/jobs\/[^/]+$/)){
 const parts=p.split('/'),sid=parts[3],jobId=parts[5];
 const r=await q("SELECT j.id,j.source_id,j.status,j.stage,j.progress,j.message,j.pages_scanned AS \"pagesScanned\",j.items_found AS \"itemsFound\",j.items_imported AS \"itemsImported\",j.error_count AS \"errorCount\",j.result,j.created_at AS \"createdAt\",j.updated_at AS \"updatedAt\" FROM collection_jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=$1 AND j.source_id=$2 AND s.user_id=$3",[jobId,sid,uo.id]);
 if(!r.rowCount)return json(res,404,{error:'Coleta não encontrada'});
 return json(res,200,r.rows[0]);
}
if(req.method==='GET'&&p.match(/^\/api\/sources\/[^/]+\/job$/)){
 const sid=p.split('/')[3],own=await q('SELECT id FROM sources WHERE id=$1 AND user_id=$2',[sid,uo.id]);if(!own.rowCount)return json(res,404,{error:'Fonte não encontrada'});const j=await latestJob(sid);return json(res,200,{job:j});
}
if(req.method==='DELETE'&&p.match(/^\/api\/sources\/[^/]+$/)){await q('DELETE FROM sources WHERE id=$1 AND user_id=$2',[p.split('/')[3],uo.id]);return json(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/library'){const d=await library(uo.id),s=String(u.searchParams.get('search')||'').toLowerCase(),t=u.searchParams.get('type');if(s||t)d.items=d.items.filter(x=>(!s||x.name.toLowerCase().includes(s))&&(!t||t==='all'||x.type===t));return json(res,200,d)}
if(req.method==='PATCH'&&p.match(/^\/api\/items\/[^/]+$/)){const item=p.split('/')[3],b=await body(req),map={name:'name',originalName:'original_name',group:'group_name',logo:'logo',streamUrl:'stream_url',description:'description',status:'status',category:'category',country:'country',language:'language',genres:'genres',year:'year',streamType:'stream_type'};for(const k in map)if(Object.hasOwn(b,k))await q('UPDATE items SET '+map[k]+'=$1 WHERE id=$2 AND source_id IN (SELECT id FROM sources WHERE user_id=$3)',[b[k],item,uo.id]);return json(res,200,{ok:true})}
if(req.method==='DELETE'&&p.match(/^\/api\/items\/[^/]+$/)){await q('DELETE FROM items WHERE id=$1 AND source_id IN (SELECT id FROM sources WHERE user_id=$2)',[p.split('/')[3],uo.id]);return json(res,200,{ok:true})}
if(req.method==='POST'&&p==='/api/collect'){try{const b=await body(req);return json(res,200,await fetchSource(String(b.url||''),String(b.type||'website')))}catch(e){return json(res,400,{error:e.message})}}
if(req.method==='POST'&&p==='/api/diagnosis'){const all=(await q("SELECT i.id,i.type,i.stream_url FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.stream_url<>'' ORDER BY i.created_at DESC LIMIT 5000",[uo.id])).rows,results=[];let online=0,errors=0,timeouts=0;for(const x of all){const z=await checkUrl(x.stream_url);if(z.status==='online')online++;else if(z.status==='timeout')timeouts++;else errors++;await q('UPDATE items SET status=$1,last_verified_at=now() WHERE id=$2',[z.status,x.id]);results.push({id:x.id,type:x.type,...z})}const run={id:id(),kind:'diagnosis',total:all.length,online,errors,timeouts,results};await q('INSERT INTO verification_runs(id,kind,total,online,errors,timeouts,results) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,run.kind,run.total,online,errors,timeouts,JSON.stringify(results)]);return json(res,200,run)}
if(req.method==='GET'&&p==='/api/monitoring'){const runs=await q('SELECT id,kind,total,online,errors,timeouts,created_at AS "createdAt" FROM verification_runs ORDER BY created_at DESC LIMIT 30'),sources=await q('SELECT id,name,status,last_collected_at AS "lastCollectedAt",last_verified_at AS "lastVerifiedAt" FROM sources WHERE user_id=$1 ORDER BY created_at DESC',[uo.id]);return json(res,200,{runs:runs.rows,sources:sources.rows})}
if(req.method==='POST'&&p==='/api/monitoring/run'){const all=(await q("SELECT i.id,i.stream_url FROM items i JOIN sources s ON s.id=i.source_id WHERE s.user_id=$1 AND i.stream_url<>'' ORDER BY i.created_at DESC LIMIT 5000",[uo.id])).rows;let online=0,errors=0,timeouts=0;for(const x of all){const z=await checkUrl(x.stream_url);if(z.status==='online')online++;else if(z.status==='timeout')timeouts++;else errors++;await q('UPDATE items SET status=$1,last_verified_at=now() WHERE id=$2',[z.status,x.id])}const run={id:id(),kind:'monitoring',total:all.length,online,errors,timeouts};await q('INSERT INTO verification_runs(id,kind,total,online,errors,timeouts) VALUES($1,$2,$3,$4,$5,$6)',[run.id,run.kind,run.total,online,errors,timeouts]);return json(res,200,run)}
if(req.method==='POST'&&p==='/api/merge'){const b=await body(req),ids=Array.isArray(b.sourceIds)?b.sourceIds:[],owned=(await q('SELECT id FROM sources WHERE user_id=$1 AND id=ANY($2::uuid[])',[uo.id,ids])).rows.map(x=>x.id),r=await q('SELECT i.id,i.type,i.name,i.group_name AS "group",i.logo,i.stream_url AS "streamUrl" FROM items i WHERE i.source_id=ANY($1::uuid[]) AND i.stream_url<>\'\'',[owned]),seen=new Set(),items=[];for(const x of r.rows){const k=(x.streamUrl||x.name).toLowerCase();if(!seen.has(k)){seen.add(k);items.push(x)}}return json(res,200,{count:items.length,items,preview:m3u(items)})}
if(req.method==='GET'&&p==='/api/generated')return json(res,200,{items:(await q('SELECT id,name,format,item_count AS "itemCount",created_at AS "createdAt" FROM generated_sources WHERE user_id=$1 ORDER BY created_at DESC',[uo.id])).rows});
if(req.method==='POST'&&p==='/api/generated'){const b=await body(req),items=Array.isArray(b.items)?b.items:[],g={id:id(),name:String(b.name||'Fonte LOS'),format:'m3u',content:m3u(items),itemCount:items.length,createdAt:now()};await q('INSERT INTO generated_sources(id,name,format,content,item_count,user_id) VALUES($1,$2,$3,$4,$5,$6)',[g.id,g.name,g.format,g.content,g.itemCount,uo.id]);return json(res,201,g)}
if(req.method==='GET'&&p.match(/^\/api\/generated\/[^/]+$/)){const r=await q('SELECT content FROM generated_sources WHERE id=$1 AND user_id=$2',[p.split('/')[3],uo.id]);if(!r.rowCount)return json(res,404,{error:'Fonte não encontrada'});return send(res,200,'application/x-mpegURL; charset=utf-8',r.rows[0].content)}
if(req.method==='GET'&&p==='/api/studio')return json(res,200,{items:(await q('SELECT id,title,description,genre,cover_url AS "coverUrl",logo_path AS "logoPath",background_video_path AS "backgroundVideoPath",platform,format,duration_seconds AS "duration",status,output_path AS "outputPath",created_at AS "createdAt" FROM studio_projects WHERE user_id=$1 ORDER BY created_at DESC',[uo.id])).rows});
if(req.method==='POST'&&p==='/api/studio'){const b=await body(req),x={id:id(),title:String(b.title||'Projeto sem título'),description:String(b.description||''),genre:String(b.genre||''),coverUrl:String(b.coverUrl||''),logoPath:String(b.logoPath||''),backgroundVideoPath:String(b.backgroundVideoPath||b.backgroundUrl||''),platform:String(b.platform||''),format:b.format==='16:9'?'16:9':'9:16',duration:Math.min(60,Math.max(5,Number(b.duration)||15)),status:'draft',outputPath:''};await q('INSERT INTO studio_projects(id,title,description,genre,cover_url,logo_path,background_video_path,platform,format,duration_seconds,status,output_path,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[x.id,x.title,x.description,x.genre,x.coverUrl,x.logoPath,x.backgroundVideoPath,x.platform,x.format,x.duration,x.status,x.outputPath,uo.id]);return json(res,201,x)}
if(req.method==='POST'&&p.match(/^\/api\/studio\/[^/]+\/render$/)){
const pid=p.split('/')[3];
const r=await q('SELECT * FROM studio_projects WHERE id=$1 AND user_id=$2',[pid,uo.id]);
if(!r.rowCount)return json(res,404,{error:'Projeto não encontrado'});
const x=r.rows[0];
const background=x.background_video_path||x.background_url||'';
if(!background)return json(res,400,{error:'Informe um vídeo público/autorizado'});
await safeUrl(background);
const out=path.join(ROOT,'studio-'+pid+'.mp4');
await q("UPDATE studio_projects SET status='rendering' WHERE id=$1",[pid]);
try{
 await new Promise((resolve,reject)=>{
  const vf=x.format==='16:9'
   ?'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'
   :'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2';
  const f=spawn('ffmpeg',['-y','-i',background,'-t',String(x.duration),'-vf',vf,'-c:v','libx264','-preset','veryfast','-c:a','aac','-movflags','+faststart',out],{stdio:['ignore','ignore','pipe']});
  let er='';
  f.stderr.on('data',d=>{er+=d});
  f.on('error',reject);
  f.on('close',code=>{
   if(code===0)resolve();
   else reject(Error(er.slice(-800)||('ffmpeg '+code)));
  });
 });
}catch(e){
 await q("UPDATE studio_projects SET status='error' WHERE id=$1",[pid]);
 return json(res,500,{error:e.message});
}
await q("UPDATE studio_projects SET status='rendered',output_path=$1 WHERE id=$2",[out,pid]);
return json(res,200,{ok:true,status:'rendered'});
}
return json(res,404,{error:'Not found'})}
const page=()=>fs.readFileSync(path.join(__dirname,'public','app.html'),'utf8');
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://'+(req.headers.host||'localhost'));if(u.pathname.startsWith('/api/'))return await api(req,res,u);if(req.method==='GET'){if(u.pathname==='/'||!path.extname(u.pathname))return send(res,200,'text/html; charset=utf-8',page());const file=path.normalize(path.join(__dirname,'public',u.pathname));if(file.startsWith(path.join(__dirname,'public'))&&fs.existsSync(file)){const ext=path.extname(file),type=ext==='.css'?'text/css':ext==='.js'?'application/javascript':'application/octet-stream';return send(res,200,type,fs.readFileSync(file))}}send(res,404,'text/plain','Not found')}catch(e){console.error('API/HTTP ERROR',req.method,req.url,e);if(!res.headersSent)json(res,500,{error:e.message||'Internal server error'});else res.end()}});
init().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('LOS COLLECTOR 4 listening on '+PORT))).catch(e=>{console.error(e);process.exit(1)});
