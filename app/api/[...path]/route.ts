import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { clearSession, createSession, hashPassword, requireUser, verifyPassword } from '@/lib/security';
import { buildM3U, parseM3U } from '@/lib/m3u';
import { discoverPublicM3U, fetchPlaylist } from '@/lib/collector';
import { checkUrl } from '@/lib/checker';
import { tmdbSearch, tmdbDetails } from '@/lib/tmdb';
import fs from 'node:fs/promises'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
export const runtime='nodejs'; export const dynamic='force-dynamic';
const json=(data:any,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store, max-age=0'}});
const fail=(e:any)=>{ console.error('[LOS COLLECTOR API]',e); return e?.message==='UNAUTHORIZED'?json({error:'Sessão expirada.'},401):json({error:e?.message||'Erro interno.'},400); };
async function body(req:NextRequest){try{return await req.json();}catch{return {};}}
async function ensureBootstrap(){
  const email=(process.env.BOOTSTRAP_ADMIN_EMAIL||'').trim().toLowerCase(), password=process.env.BOOTSTRAP_ADMIN_PASSWORD||'';
  if(!email||!password) return;
  const r=await query<{id:string}>('SELECT id FROM users WHERE email=$1',[email]);
  if(!r.rowCount) await query('INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)',[email,hashPassword(password),'owner']);
}
export async function GET(req:NextRequest,{params}:{params:Promise<{path:string[]}>}){ const p=(await params).path.join('/'); try{
  if(p==='health') return json({ok:true,service:'los-collector'});
  if(p==='auth/me'){const u=await requireUser();return json({user:u});}
  if(p==='dashboard'){const u=await requireUser(); const [s,c,o,e]=await Promise.all([query('SELECT count(*)::int count FROM sources WHERE user_id=$1',[u.id]),query('SELECT count(*)::int count FROM contents WHERE user_id=$1',[u.id]),query("SELECT count(*)::int count FROM contents WHERE user_id=$1 AND status='ONLINE'",[u.id]),query("SELECT count(*)::int count FROM contents WHERE user_id=$1 AND status IN ('ERRO','TIMEOUT')",[u.id])]);return json({sources:s.rows[0].count,contents:c.rows[0].count,online:o.rows[0].count,errors:e.rows[0].count});}
  if(p==='sources'){const u=await requireUser();const r=await query('SELECT * FROM sources WHERE user_id=$1 ORDER BY created_at DESC',[u.id]);return json({sources:r.rows});}
  if(p==='library'){const u=await requireUser();const q=new URL(req.url).searchParams;const category=q.get('category');const status=q.get('status');const args:any[]=[u.id];let where='WHERE c.user_id=$1';if(category&&category!=='TODOS'){args.push(category);where+=` AND c.category=$${args.length}`;}if(status&&status!=='TODOS'){args.push(status);where+=` AND c.status=$${args.length}`;}const r=await query(`SELECT c.*,s.name source_name FROM contents c LEFT JOIN sources s ON s.id=c.source_id ${where} ORDER BY c.discovered_at DESC LIMIT 1000`,args);return json({contents:r.rows});}
  if(p==='library/export'){const u=await requireUser();const r=await query<any>('SELECT title,url,group_name,logo_url,category FROM contents WHERE user_id=$1 ORDER BY category,title',[u.id]);const text=buildM3U(r.rows.map((x:any)=>({title:x.title,url:x.url,group:x.group_name||'',logo:x.logo_url||'',category:x.category,attrs:{}})));return new NextResponse(text,{headers:{'Content-Type':'audio/x-mpegurl; charset=utf-8','Content-Disposition':'attachment; filename=los-collector.m3u'}});}
  if(p==='studio/history'){const u=await requireUser();const r=await query('SELECT * FROM studio_projects WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id]);return json({projects:r.rows});}
  if(p==='studio/file'){const u=await requireUser();const id=new URL(req.url).searchParams.get('id');const r=await query<any>('SELECT output_path FROM studio_projects WHERE id=$1 AND user_id=$2',[id,u.id]);if(!r.rowCount)return json({error:'Arquivo não encontrado.'},404);const root=process.env.STORAGE_ROOT||path.join(process.cwd(),'storage');const rel=String(r.rows[0].output_path||'').replace(/^[/\\]+/,'');if(rel.split(/[\\/]+/).some(part=>part==='..'))return json({error:'Caminho inválido.'},400);const file=path.join(/*turbopackIgnore: true*/ root,rel);const data=await fs.readFile(file);return new NextResponse(data,{headers:{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename=\"los-collector-studio.mp4\"'}});}
  return json({error:'Rota não encontrada.'},404);
 }catch(e){return fail(e);} }
export async function POST(req:NextRequest,{params}:{params:Promise<{path:string[]}>}){ const p=(await params).path.join('/'); try{
  if(p==='auth/login'){const b=await body(req);const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');if(!email||!password)return json({error:'Informe e-mail e senha.'},422);await ensureBootstrap();const r=await query<any>('SELECT * FROM users WHERE email=$1',[email]);if(!r.rowCount||!verifyPassword(password,r.rows[0].password_hash))return json({error:'E-mail ou senha inválidos.'},401);await createSession(r.rows[0].id);return json({ok:true});}
  if(p==='auth/logout'){await clearSession();return json({ok:true});}
  const u=await requireUser();
  if(p==='sources'){const b=await body(req);const name=String(b.name||'Fonte').trim().slice(0,120), url=String(b.url||'').trim();if(!url)return json({error:'URL obrigatória.'},422);const result=await discoverPublicM3U(url);const existing=await query<{id:string}>('SELECT id FROM sources WHERE user_id=$1 AND url=$2',[u.id,url]);let sourceId=existing.rows[0]?.id;if(!sourceId){const ins=await query<{id:string}>('INSERT INTO sources(user_id,name,url,status,content_count,last_checked_at,next_check_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval \'6 hours\') RETURNING id',[u.id,name,url,'ONLINE',result.length]);sourceId=ins.rows[0].id;}else await query('UPDATE sources SET name=$1,status=$2,content_count=$3,last_checked_at=now(),next_check_at=now()+interval \'6 hours\',last_error=NULL,updated_at=now() WHERE id=$4 AND user_id=$5',[name,'ONLINE',result.length,sourceId,u.id]);let added=0;for(const item of result){const r=await query('INSERT INTO contents(user_id,source_id,title,url,category,group_name,logo_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,url) DO UPDATE SET source_id=EXCLUDED.source_id,title=EXCLUDED.title,category=EXCLUDED.category,group_name=EXCLUDED.group_name,logo_url=EXCLUDED.logo_url RETURNING (xmax=0) inserted',[u.id,sourceId,item.title,item.url,item.category,item.group,item.logo]);if(r.rows[0]?.inserted)added++;}return json({ok:true,found:result.length,added,sourceId});}
  if(p==='sources/check'){const b=await body(req);const id=String(b.id||'');const r=await query<any>('SELECT * FROM sources WHERE id=$1 AND user_id=$2',[id,u.id]);if(!r.rowCount)return json({error:'Fonte não encontrada.'},404);try{const result=await discoverPublicM3U(r.rows[0].url);await query('UPDATE sources SET status=\'ONLINE\',content_count=$1,last_checked_at=now(),next_check_at=now()+make_interval(mins => interval_minutes),last_error=NULL,updated_at=now() WHERE id=$2',[result.length,id]);for(const item of result)await query('INSERT INTO contents(user_id,source_id,title,url,category,group_name,logo_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,url) DO UPDATE SET source_id=EXCLUDED.source_id,title=EXCLUDED.title,category=EXCLUDED.category,group_name=EXCLUDED.group_name,logo_url=EXCLUDED.logo_url',[u.id,id,item.title,item.url,item.category,item.group,item.logo]);return json({ok:true,found:result.length});}catch(e:any){await query('UPDATE sources SET status=\'ERROR\',last_checked_at=now(),next_check_at=now()+make_interval(mins => interval_minutes),last_error=$1,updated_at=now() WHERE id=$2',[e.message,id]);throw e;}}
  if(p==='diagnosis'){const b=await body(req);const ids=Array.isArray(b.ids)?b.ids.map(String):[];const r=await query<any>('SELECT id,url FROM contents WHERE user_id=$1 AND id=ANY($2::uuid[])',[u.id,ids]);const results=[];for(const item of r.rows){const c=await checkUrl(item.url);results.push({id:item.id,...c});await query('UPDATE contents SET status=$1,status_code=$2,response_ms=$3,checked_at=now() WHERE id=$4 AND user_id=$5',[c.status,c.statusCode,c.responseMs,item.id,u.id]);}return json({results});}
  if(p==='jobs/monitor'){if(req.headers.get('x-job-secret')!==process.env.JOB_SECRET)return json({error:'Forbidden'},403);const due=await query<any>('SELECT * FROM sources WHERE next_check_at IS NULL OR next_check_at<=now() ORDER BY next_check_at NULLS FIRST LIMIT 100');let checked=0;for(const src of due.rows){try{const result=await discoverPublicM3U(src.url);await query("UPDATE sources SET status='ONLINE',content_count=$1,last_checked_at=now(),next_check_at=now()+make_interval(mins => interval_minutes),last_error=NULL,updated_at=now() WHERE id=$2",[result.length,src.id]);for(const item of result)await query('INSERT INTO contents(user_id,source_id,title,url,category,group_name,logo_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,url) DO UPDATE SET source_id=EXCLUDED.source_id,title=EXCLUDED.title,category=EXCLUDED.category,group_name=EXCLUDED.group_name,logo_url=EXCLUDED.logo_url',[src.user_id,src.id,item.title,item.url,item.category,item.group,item.logo]);checked++;}catch(e:any){await query("UPDATE sources SET status='ERROR',last_checked_at=now(),next_check_at=now()+make_interval(mins => interval_minutes),last_error=$1,updated_at=now() WHERE id=$2",[e.message,src.id]);}}return json({ok:true,checked});}
  if(p==='settings/password'){const b=await body(req);const current=String(b.current||''), next=String(b.next||'');const r=await query<any>('SELECT password_hash FROM users WHERE id=$1',[u.id]);if(!verifyPassword(current,r.rows[0].password_hash))return json({error:'Senha atual incorreta.'},401);if(next.length<8)return json({error:'A nova senha precisa ter pelo menos 8 caracteres.'},422);await query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2',[hashPassword(next),u.id]);return json({ok:true});}
  if(p==='tmdb/search'){const b=await body(req);return json({results:await tmdbSearch(String(b.query||''),b.type==='tv'?'tv':'movie')});}
  if(p==='tmdb/details'){const b=await body(req);return json({details:await tmdbDetails(String(b.id),b.type==='tv'?'tv':'movie')});}
  if(p==='studio/upload'){const form=await req.formData();const kind=String(form.get('kind')||'');const file=form.get('file');if(!(file instanceof File))return json({error:'Arquivo não enviado.'},422);if(!['logo','background'].includes(kind))return json({error:'Tipo de upload inválido.'},422);const max=kind==='background'?200:10; const allowed=kind==='background'?['video/mp4','video/webm','video/quicktime','video/x-matroska']:['image/png','image/jpeg','image/webp']; if(file.type && !allowed.includes(file.type))return json({error:'Formato de arquivo não permitido.'},422);const bytes=await file.arrayBuffer();if(bytes.byteLength>max*1024*1024)return json({error:`Arquivo acima de ${max} MB.`},422);const ext=(file.name.split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'');const root=process.env.STORAGE_ROOT||path.join(process.cwd(),'storage');const dir=path.join(/*turbopackIgnore: true*/ root,'uploads');await fs.mkdir(dir,{recursive:true});const out=path.join(/*turbopackIgnore: true*/ dir,`${crypto.randomUUID()}.${ext}`);await fs.writeFile(out,Buffer.from(bytes));const relative=path.relative(root,out).replaceAll('\\','/'); return json({ok:true,path:relative});}
  if(p==='studio/render'){
    const b=await body(req);
    const title=String(b.title||'').trim();
    if(!title)return json({error:'Título obrigatório.'},422);
    const duration=Math.min(120,Math.max(5,Number(b.duration)||15));
    const format=b.format==='16:9'?'16:9':'9:16';
    const root=process.env.STORAGE_ROOT||path.join(process.cwd(),'storage');
    const outDir=path.join(/*turbopackIgnore: true*/ root,'generated');
    await fs.mkdir(outDir,{recursive:true});
    const id=crypto.randomUUID();
    const output=path.join(outDir,`${id}.mp4`);
    const cover=String(b.cover||'').trim();
    let coverPath='';
    if(cover){
      const cu=new URL(cover);
      if(cu.protocol!=='https:' || cu.hostname!=='image.tmdb.org')throw new Error('Capa inválida.');
      const cr=await fetch(cu);
      if(!cr.ok)throw new Error('Não foi possível obter a capa do TMDB.');
      const buf=Buffer.from(await cr.arrayBuffer());
      if(buf.byteLength>10*1024*1024)throw new Error('Capa muito grande.');
      coverPath=path.join(/*turbopackIgnore: true*/ root,`${id}-cover.jpg`);
      await fs.writeFile(coverPath,buf);
    }
    const normalizeRelative=(value:string)=>value.trim().replace(/^[/\\]+/,'');
    const isSafeRelative=(value:string)=>value==='' || !value.split(/[\\/]+/).some(part=>part==='..');
    const bgRaw=normalizeRelative(String(b.backgroundPath||''));
    const logoRaw=normalizeRelative(String(b.logoPath||''));
    if(!isSafeRelative(bgRaw)||!isSafeRelative(logoRaw))throw new Error('Caminho de arquivo inválido.');
    const bgPath=bgRaw?path.join(/*turbopackIgnore: true*/ root,bgRaw):'';
    const logoPath=logoRaw?path.join(/*turbopackIgnore: true*/ root,logoRaw):'';
    const titleFile=path.join(/*turbopackIgnore: true*/ root,`${id}-title.txt`);
    const infoFile=path.join(/*turbopackIgnore: true*/ root,`${id}-info.txt`);
    const info=[String(b.genre||'').trim(),String(b.description||'').trim()].filter(Boolean).join(' • ').slice(0,500);
    await fs.writeFile(titleFile,title,'utf8');
    await fs.writeFile(infoFile,info,'utf8');
    const vf=format==='9:16'?'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p':'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p';
    const titleFilter=`drawtext=textfile='${titleFile}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=h-250:box=1:boxcolor=black@0.45:boxborderw=18`;
    const infoFilter=info?`,drawtext=textfile='${infoFile}':fontcolor=white:fontsize=30:x=(w-text_w)/2:y=h-150:box=1:boxcolor=black@0.35:boxborderw=12`:'';
    const logoFilter=logoPath?`,movie='${logoPath}',scale2ref=w=220:h=-1[logo][base];[base][logo]overlay=W-w-40:40`:'';
    let args:any[];
    if(bgPath){
      args=['-stream_loop','-1','-i',bgPath,'-t',String(duration),'-vf',`${vf},${titleFilter}${infoFilter}${logoFilter}`,'-r','30','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',output];
    }else if(coverPath){
      args=['-loop','1','-i',coverPath,'-t',String(duration),'-vf',`${vf},${titleFilter}${infoFilter}${logoFilter}`,'-r','30','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',output];
    }else{
      args=['-f','lavfi','-i',`color=c=black:s=${format==='9:16'?'1080x1920':'1920x1080'}:d=${duration}`,'-vf',`format=yuv420p,${titleFilter}${infoFilter}${logoFilter}`,'-r','30','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',output];
    }
    try{
      await new Promise<void>((resolve,reject)=>{const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});let err='';child.stderr.on('data',d=>err+=d.toString());child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg falhou: ${err.slice(-500)}`)));});
    }finally{
      await Promise.allSettled([fs.unlink(titleFile),fs.unlink(infoFile),coverPath?fs.unlink(coverPath):Promise.resolve()]);
    }
    const rel=path.relative(root,output).replaceAll('\\','/');
    const ins=await query<{id:string}>('INSERT INTO studio_projects(user_id,title,description,genre,cover_url,logo_path,background_video_path,platform,format,duration_seconds,output_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',[u.id,title,String(b.description||''),String(b.genre||''),cover,logoRaw,bgRaw,String(b.platform||'Instagram Reels'),format,duration,rel]);
    return json({ok:true,id:ins.rows[0].id,file:rel});
  }
  return json({error:'Rota não encontrada.'},404);
 }catch(e){return fail(e);} }
