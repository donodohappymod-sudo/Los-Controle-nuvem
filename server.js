const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),dns=require('node:dns').promises,{URL}=require('node:url'),{Pool}=require('pg'),{spawn}=require('node:child_process');
const PORT=Number(process.env.PORT||10000),ROOT=process.env.STORAGE_ROOT||path.join(process.cwd(),'storage');
fs.mkdirSync(ROOT,{recursive:true});
const secret=process.env.SESSION_SECRET||crypto.randomBytes(48).toString('base64url'); if(secret.length<32)throw Error('SESSION_SECRET deve ter pelo menos 32 caracteres');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const bootEmail=(process.env.BOOTSTRAP_ADMIN_EMAIL||'miguelalvesmillk@gmail.com').trim().toLowerCase(),bootPassword=process.env.BOOTSTRAP_ADMIN_PASSWORD||'change-this-before-production';
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
CREATE TABLE IF NOT EXISTS studio_projects(id uuid primary key,title text not null,description text,cover_url text,background_url text,format text not null,duration int not null,status text not null,output_path text,created_at timestamptz not null default now());
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
"ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS duration_seconds int NOT NULL DEFAULT 15"
];
for(const sql of alters) await q(sql);
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
function htmlItems(text,baseUrl){
 const src=String(text||'').replaceAll('\\/','/').replace(/&amp;/gi,'&'),out=[],seen=new Set(),pages=[];
 const addMedia=(raw,meta='',kind='website')=>{
  const u=absoluteUrl(raw,baseUrl);if(!u||seen.has(u)||seen.size>=1000)return;
  if(!/^https?:/i.test(u))return;
  const streamType=classifyMediaUrl(u,meta);
  const likely=streamType||/(stream|live|playlist|video|movie|episode|channel|tv|iptv|media|manifest)/i.test(u+' '+meta);
  if(!likely)return;
  seen.add(u);
  const n=streamNameFromUrl(u,'Conteúdo encontrado');
  out.push({type:classifyContent(n,u,meta),name:n,originalName:n,group:'',logo:'',streamUrl:u,status:'unknown',streamType:streamType||'stream',metadata:{discoveredFrom:kind,context:meta.slice(0,500)}});
 };
 const addPage=(raw)=>{
  const u=absoluteUrl(raw,baseUrl);if(!u||!/^https?:/i.test(u))return;
  try{const x=new URL(u),base=new URL(baseUrl);if(x.hostname!==base.hostname)return;if(/\.(?:jpg|jpeg|png|gif|svg|css|js|ico|woff2?|pdf|zip)(?:$|[?#])/i.test(x.pathname))return;pages.push(x.toString())}catch{}
 };
 for(const m of src.matchAll(/(?:href|src|data-src|data-url|data-href|content)\s*=\s*["']([^"']+)["']/gi)){
  const raw=m[1],tag=m[0].toLowerCase();
  if(/href|data-href/.test(tag))addPage(raw);
  addMedia(raw,tag,'html-attribute');
 }
 for(const m of src.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi))addMedia(m[0],'absolute-url','html');
 for(const m of src.matchAll(/(?:^|["'\s])(\/?[^"'\s<>]+\.(?:m3u8?|m3u|mp4|m4v|webm|mov|mkv|ts|mpd)(?:\?[^"'\s<>]*)?)/gi))addMedia(m[1],'extension','embedded-url');
 for(const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi))addMedia(m[1],'css-url','css');
 return {items:out,pages:[...new Set(pages)]};
}
async function crawlWebsite(rootUrl,options={}){
 const maxPages=Math.min(100,Math.max(5,Number(options.maxPages)||50)),maxDepth=Math.min(3,Math.max(0,Number(options.maxDepth)||2));
 const root=new URL(rootUrl),queue=[{url:root.toString(),depth:0}],queued=new Set([root.toString()]),visited=new Set(),items=[],seenItems=new Set(),playlists=new Set(),errors=[];
 async function worker(){
  while(queue.length){
   const job=queue.shift();if(!job||visited.has(job.url)||job.depth>maxDepth)continue;
   visited.add(job.url);
   try{
    const r=await fetchText(job.url),parsed=htmlItems(r.text,r.url);
    for(const x of parsed.items){
     const key=(x.streamUrl||'').toLowerCase();if(!key||seenItems.has(key))continue;
     seenItems.add(key);items.push(x);if(x.streamType==='m3u8')playlists.add(x.streamUrl);
    }
    if(visited.size<maxPages)for(const p of parsed.pages){
     if(visited.has(p)||queued.has(p)||queue.length+visited.size>=maxPages)continue;
     queued.add(p);queue.push({url:p,depth:job.depth+1});
    }
   }catch(e){if(errors.length<30)errors.push({url:job.url,error:e.message})}
  }
 }
 await Promise.all(Array.from({length:Math.min(5,maxPages)},worker));
 const playlistItems=[];
 for(const u of playlists){
  try{
   const r=await fetchText(u),parsed=parseM3U(r.text,r.url,u);
   for(const x of parsed.items){const k=(x.streamUrl||'').toLowerCase();if(k&&!seenItems.has(k)){seenItems.add(k);playlistItems.push(x)}}
  }catch(e){if(errors.length<30)errors.push({url:u,error:'Playlist: '+e.message})}
 }
 const finalItems=[...items,...playlistItems].slice(0,10000);
 return {kind:'website',sourceUrl:rootUrl,items:finalItems,pagesScanned:visited.size,pagesQueued:queued.size,playlistsFound:playlists.size,errors,discovered:finalItems.length,message:'Varredura concluída: '+visited.size+' página(s), '+playlists.size+' playlist(s) e '+finalItems.length+' conteúdo(s) identificado(s).'};
}
async function fetchSource(raw,requestedType='website'){
 const sourceUrl=String(raw||'').trim();if(!sourceUrl)throw Error('URL da fonte é obrigatória');
 const type=String(requestedType||'website').toLowerCase(),root=await fetchText(sourceUrl),pathName=new URL(root.url).pathname.toLowerCase(),text=root.text||'';
 const detectedM3U=/\.(?:m3u8?|m3u)(?:$|[?#])/i.test(root.url)||/mpegurl|x-mpegurl/i.test(root.contentType)||/^\s*#EXTM3U/i.test(text)||/^\s*#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/i.test(text);
 if(type==='m3u'||type==='m3u8'||detectedM3U){
  const parsed=parseM3U(text,root.url,root.url);
  if(parsed.items.length)return {kind:'m3u',sourceUrl:root.url,items:parsed.items,discovered:parsed.items.length,playlists:[root.url],pagesScanned:1,errors:[],message:parsed.isMaster?'Playlist HLS mestre analisada.':parsed.isMedia?'Stream HLS identificado.':'Playlist M3U/M3U8 analisada.'};
  if(type==='m3u8'||/m3u8/i.test(root.url)||/mpegurl|x-mpegurl/i.test(root.contentType)){
   const n=streamNameFromUrl(root.url,'Stream M3U8');
   return {kind:'m3u8',sourceUrl:root.url,items:[{type:'channel',name:n,originalName:n,group:'',logo:'',streamUrl:root.url,status:'unknown',streamType:'m3u8',metadata:{discoveredFrom:'direct-m3u8'}}],discovered:1,playlists:[root.url],pagesScanned:1,errors:[],message:'Stream M3U8 direto identificado.'};
  }
 }
 return crawlWebsite(root.url,{maxPages:50,maxDepth:2});
}

async function checkUrl(raw){const started=Date.now();try{const u=await safeUrl(raw),ac=new AbortController(),timer=setTimeout(()=>ac.abort(),12000);let r;try{r=await fetch(u,{method:'HEAD',redirect:'manual',signal:ac.signal,headers:{'user-agent':'LOS-COLLECTOR-CHECK/4.0'}});if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');if(loc){const target=new URL(loc,u);await safeUrl(target);r=await fetch(target,{method:'HEAD',redirect:'manual',signal:ac.signal,headers:{'user-agent':'LOS-COLLECTOR-CHECK/4.0'}})}}if(r.status===405||r.status===501)r=await fetch(u,{method:'GET',redirect:'manual',signal:ac.signal,headers:{range:'bytes=0-0','user-agent':'LOS-COLLECTOR-CHECK/4.0'}})}finally{clearTimeout(timer)}return {status:r.ok?'online':'error',httpStatus:r.status,responseMs:Date.now()-started,reason:r.ok?'OK':'HTTP '+r.status}}catch(e){return {status:e.name==='AbortError'?'timeout':'error',responseMs:Date.now()-started,reason:e.name==='AbortError'?'Timeout':e.message}}}
async function importItems(sourceId,items){
 const summary={received:items.length,imported:0,failed:0,errors:[]};
 for(const x of items){
  try{
   if(!x.streamUrl)throw Error('Item sem URL');
   await safeUrl(x.streamUrl);
   await q('INSERT INTO items(id,source_id,type,name,original_name,group_name,logo,stream_url,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id(),sourceId,x.type||'channel',x.name||'Sem nome',x.originalName||x.name||'',x.group||'',x.logo||'',x.streamUrl,x.status||'unknown',JSON.stringify(x.metadata||{})]);
   summary.imported++;
  }catch(e){summary.failed++;if(summary.errors.length<20)summary.errors.push({name:x.name||'Sem nome',url:x.streamUrl||'',error:e.message})}
 }
 return summary
}
function m3u(items){return '#EXTM3U\n'+items.map(x=>'#EXTINF:-1'+(x.group?' group-title="'+String(x.group).replaceAll('"','&quot;')+'"':'')+(x.logo?' tvg-logo="'+String(x.logo).replaceAll('"','&quot;')+'"':'')+','+(x.name||x.title||'Sem nome')+'\n'+(x.streamUrl||'')).join('\n')}
async function library(){const [a,s,e]=await Promise.all([q('SELECT id,source_id,type,name,original_name AS "originalName",group_name AS "group",category,country,language,logo,stream_url AS "streamUrl",stream_type AS "streamType",year,genres,description,status,last_verified_at AS "lastVerifiedAt",metadata FROM items ORDER BY created_at DESC LIMIT 5000'),q('SELECT id,source_id,title,original_title AS "originalTitle",year,genres,cover_url AS "coverUrl",description,status,metadata FROM series ORDER BY created_at DESC LIMIT 2000'),q('SELECT id,series_id,source_id,season_id,number,title,description,duration,stream_url AS "streamUrl",status,last_verified_at AS "lastVerifiedAt",metadata FROM episodes ORDER BY number LIMIT 5000')]);return {items:a.rows,series:s.rows,episodes:e.rows}}
async function dashboard(){const names=['sources','channel','movie','series','episode','online','error'];const sql=['SELECT count(*)::int n FROM sources',"SELECT count(*)::int n FROM items WHERE type='channel'","SELECT count(*)::int n FROM items WHERE type='movie'","SELECT count(*)::int n FROM series","SELECT count(*)::int n FROM episodes","SELECT count(*)::int n FROM items WHERE status='online'","SELECT count(*)::int n FROM items WHERE status IN ('error','timeout')"];const r=await Promise.all(sql.map(x=>q(x)));const v=r.map(x=>x.rows[0].n);return {sources:v[0],channels:v[1],movies:v[2],series:v[3],episodes:v[4],online:v[5],errors:v[6]}}
async function api(req,res,u){const p=u.pathname;
if(req.method==='GET'&&p==='/api/health'){try{await q('SELECT 1');return json(res,200,{ok:true,database:true,time:now()})}catch(e){return json(res,503,{ok:false,database:false,error:e.message})}}
if(req.method==='POST'&&p==='/api/auth/login'){const b=await body(req),email=String(b.email||'').trim().toLowerCase(),pw=String(b.password||''),r=await q('SELECT id,email,password_hash FROM users WHERE email=$1',[email]);if(!r.rowCount||!(await verify(pw,r.rows[0].password_hash))){if(!r.rowCount||email!==bootEmail||pw!==bootPassword)return json(res,401,{error:'Email ou senha inválidos'});await q('UPDATE users SET password_hash=$1 WHERE id=$2',[await hash(pw),r.rows[0].id]);await q('DELETE FROM sessions WHERE user_id=$1',[r.rows[0].id])}const raw=crypto.randomBytes(32).toString('base64url');await q("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[tokenHash(raw),r.rows[0].id]);return json(res,200,{ok:true},{'set-cookie':'los_session='+raw+'; HttpOnly; Path=/; SameSite=Lax; '+(process.env.NODE_ENV==='production'?'Secure; ':'')+'Max-Age=2592000'})}
if(req.method==='POST'&&p==='/api/auth/logout'){const t=cookie(req);if(t)await q('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(t)]);return json(res,200,{ok:true},{'set-cookie':'los_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'})}
const uo=await auth(req);if(!uo)return json(res,401,{error:'UNAUTHORIZED'});
if(req.method==='GET'&&p==='/api/auth/me')return json(res,200,{user:{id:uo.id,email:uo.email}});
if(req.method==='POST'&&p==='/api/auth/change-password'){const b=await body(req),old=String(b.currentPassword||''),nw=String(b.newPassword||'');if(nw.length<10)return json(res,400,{error:'Nova senha: mínimo de 10 caracteres'});const r=await q('SELECT password_hash FROM users WHERE id=$1',[uo.id]);if(!(await verify(old,r.rows[0].password_hash)))return json(res,400,{error:'Senha atual inválida'});await q('UPDATE users SET password_hash=$1 WHERE id=$2',[await hash(nw),uo.id]);await q('DELETE FROM sessions WHERE user_id=$1',[uo.id]);return json(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/dashboard')return json(res,200,await dashboard());
if(req.method==='GET'&&p==='/api/sources'){const r=await q("SELECT s.*,(SELECT count(*) FROM items i WHERE i.source_id=s.id AND i.type='channel')::int channels,(SELECT count(*) FROM items i WHERE i.source_id=s.id AND i.type='movie')::int movies,(SELECT count(*) FROM series x WHERE x.source_id=s.id)::int series,(SELECT count(*) FROM episodes e WHERE e.source_id=s.id)::int episodes FROM sources s ORDER BY created_at DESC");return json(res,200,{items:r.rows})}
if(req.method==='POST'&&p==='/api/sources'){const b=await body(req),name=String(b.name||'').trim(),url=String(b.url||'').trim();if(!name||!url)return json(res,400,{error:'Nome e URL são obrigatórios'});await safeUrl(url);const sid=id();await q('INSERT INTO sources(id,name,url,type) VALUES($1,$2,$3,$4)',[sid,name,String(b.type||'website')]);if(b.collectNow){try{const c=await fetchSource(url,String(b.type||'website')),summary=await importItems(sid,c.items);await q('UPDATE sources SET last_collected_at=now(),content_count=$2,last_error=$3,status=$4,updated_at=now() WHERE id=$1',[sid,summary.imported,summary.failed?JSON.stringify(summary.errors.slice(0,5)):'',summary.imported||c.items.length?'active':'warning']);return json(res,201,{source:{id:sid,name,url,type:String(b.type||'website')},collected:{...c,summary}})}catch(e){await q("UPDATE sources SET status='error' WHERE id=$1",[sid]);return json(res,400,{error:'Fonte criada, coleta falhou: '+e.message,sourceId:sid})}}return json(res,201,{source:{id:sid,name,url}})}
if(req.method==='POST'&&p.match(/^\/api\/sources\/[^/]+\/collect$/)){const sid=p.split('/')[3],r=await q('SELECT * FROM sources WHERE id=$1',[sid]);if(!r.rowCount)return json(res,404,{error:'Fonte não encontrada'});try{const c=await fetchSource(r.rows[0].url,r.rows[0].type),summary=await importItems(sid,c.items);await q('UPDATE sources SET last_collected_at=now(),content_count=$2,last_error=$3,status=$4,updated_at=now() WHERE id=$1',[sid,summary.imported,summary.failed?JSON.stringify(summary.errors.slice(0,5)):'',summary.imported||c.items.length?'active':'warning']);return json(res,200,{...c,count:c.items.length,summary})}catch(e){await q("UPDATE sources SET status='error' WHERE id=$1",[sid]);return json(res,400,{error:e.message})}}
if(req.method==='DELETE'&&p.match(/^\/api\/sources\/[^/]+$/)){await q('DELETE FROM sources WHERE id=$1',[p.split('/')[3]]);return json(res,200,{ok:true})}
if(req.method==='GET'&&p==='/api/library'){const d=await library(),s=String(u.searchParams.get('search')||'').toLowerCase(),t=u.searchParams.get('type');if(s||t)d.items=d.items.filter(x=>(!s||x.name.toLowerCase().includes(s))&&(!t||t==='all'||x.type===t));return json(res,200,d)}
if(req.method==='PATCH'&&p.match(/^\/api\/items\/[^/]+$/)){const item=p.split('/')[3],b=await body(req),map={name:'name',originalName:'original_name',group:'group_name',logo:'logo',streamUrl:'stream_url',description:'description',status:'status',category:'category',country:'country',language:'language',genres:'genres',year:'year',streamType:'stream_type'};for(const k in map)if(Object.hasOwn(b,k))await q('UPDATE items SET '+map[k]+'=$1 WHERE id=$2',[b[k],item]);return json(res,200,{ok:true})}
if(req.method==='DELETE'&&p.match(/^\/api\/items\/[^/]+$/)){await q('DELETE FROM items WHERE id=$1',[p.split('/')[3]]);return json(res,200,{ok:true})}
if(req.method==='POST'&&p==='/api/collect'){try{const b=await body(req);return json(res,200,await fetchSource(String(b.url||''),String(b.type||'website')))}catch(e){return json(res,400,{error:e.message})}}
if(req.method==='POST'&&p==='/api/diagnosis'){const all=(await q("SELECT id,type,stream_url FROM items WHERE stream_url<>'' ORDER BY created_at DESC LIMIT 5000")).rows,results=[];let online=0,errors=0,timeouts=0;for(const x of all){const z=await checkUrl(x.stream_url);if(z.status==='online')online++;else if(z.status==='timeout')timeouts++;else errors++;await q('UPDATE items SET status=$1,last_verified_at=now() WHERE id=$2',[z.status,x.id]);results.push({id:x.id,type:x.type,...z})}const run={id:id(),kind:'diagnosis',total:all.length,online,errors,timeouts,results};await q('INSERT INTO verification_runs(id,kind,total,online,errors,timeouts,results) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,run.kind,run.total,online,errors,timeouts,JSON.stringify(results)]);return json(res,200,run)}
if(req.method==='GET'&&p==='/api/monitoring'){const runs=await q('SELECT id,kind,total,online,errors,timeouts,created_at AS "createdAt" FROM verification_runs ORDER BY created_at DESC LIMIT 30'),sources=await q('SELECT id,name,status,last_collected_at AS "lastCollectedAt",last_verified_at AS "lastVerifiedAt" FROM sources ORDER BY created_at DESC');return json(res,200,{runs:runs.rows,sources:sources.rows})}
if(req.method==='POST'&&p==='/api/monitoring/run'){const all=(await q("SELECT id,stream_url FROM items WHERE stream_url<>'' ORDER BY created_at DESC LIMIT 5000")).rows;let online=0,errors=0,timeouts=0;for(const x of all){const z=await checkUrl(x.stream_url);if(z.status==='online')online++;else if(z.status==='timeout')timeouts++;else errors++;await q('UPDATE items SET status=$1,last_verified_at=now() WHERE id=$2',[z.status,x.id])}const run={id:id(),kind:'monitoring',total:all.length,online,errors,timeouts};await q('INSERT INTO verification_runs(id,kind,total,online,errors,timeouts) VALUES($1,$2,$3,$4,$5,$6)',[run.id,run.kind,run.total,online,errors,timeouts]);return json(res,200,run)}
if(req.method==='POST'&&p==='/api/merge'){const b=await body(req),ids=Array.isArray(b.sourceIds)?b.sourceIds:[],r=await q('SELECT id,type,name,group_name AS "group",logo,stream_url AS "streamUrl" FROM items WHERE source_id=ANY($1::uuid[]) AND stream_url<>\'\'',[ids]),seen=new Set(),items=[];for(const x of r.rows){const k=(x.streamUrl||x.name).toLowerCase();if(!seen.has(k)){seen.add(k);items.push(x)}}return json(res,200,{count:items.length,items,preview:m3u(items)})}
if(req.method==='GET'&&p==='/api/generated')return json(res,200,{items:(await q('SELECT id,name,format,item_count AS "itemCount",created_at AS "createdAt" FROM generated_sources ORDER BY created_at DESC')).rows});
if(req.method==='POST'&&p==='/api/generated'){const b=await body(req),items=Array.isArray(b.items)?b.items:[],g={id:id(),name:String(b.name||'Fonte LOS'),format:'m3u',content:m3u(items),itemCount:items.length,createdAt:now()};await q('INSERT INTO generated_sources(id,name,format,content,item_count) VALUES($1,$2,$3,$4,$5)',[g.id,g.name,g.format,g.content,g.itemCount]);return json(res,201,g)}
if(req.method==='GET'&&p.match(/^\/api\/generated\/[^/]+$/)){const r=await q('SELECT content FROM generated_sources WHERE id=$1',[p.split('/')[3]]);if(!r.rowCount)return json(res,404,{error:'Fonte não encontrada'});return send(res,200,'application/x-mpegURL; charset=utf-8',r.rows[0].content)}
if(req.method==='GET'&&p==='/api/studio')return json(res,200,{items:(await q('SELECT id,title,description,genre,cover_url AS "coverUrl",logo_path AS "logoPath",background_video_path AS "backgroundVideoPath",platform,format,duration_seconds AS "duration",status,output_path AS "outputPath",created_at AS "createdAt" FROM studio_projects ORDER BY created_at DESC')).rows});
if(req.method==='POST'&&p==='/api/studio'){const b=await body(req),x={id:id(),title:String(b.title||'Projeto sem título'),description:String(b.description||''),genre:String(b.genre||''),coverUrl:String(b.coverUrl||''),logoPath:String(b.logoPath||''),backgroundVideoPath:String(b.backgroundVideoPath||b.backgroundUrl||''),platform:String(b.platform||''),format:b.format==='16:9'?'16:9':'9:16',duration:Math.min(60,Math.max(5,Number(b.duration)||15)),status:'draft',outputPath:''};await q('INSERT INTO studio_projects(id,title,description,genre,cover_url,logo_path,background_video_path,platform,format,duration_seconds,status,output_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[x.id,x.title,x.description,x.genre,x.coverUrl,x.logoPath,x.backgroundVideoPath,x.platform,x.format,x.duration,x.status,x.outputPath]);return json(res,201,x)}
if(req.method==='POST'&&p.match(/^\/api\/studio\/[^/]+\/render$/)){
const pid=p.split('/')[3];
const r=await q('SELECT * FROM studio_projects WHERE id=$1',[pid]);
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
