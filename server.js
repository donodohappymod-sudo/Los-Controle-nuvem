const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');
const PORT=process.env.PORT||3000, HOST=process.env.HOST||'0.0.0.0';
const sessions=new Map();
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,service:'controle-nuvem',version:'14.0.0'}))}
  let file=u.pathname.startsWith('/receiver')?'receiver.html':'controller.html';
  const p=path.join(__dirname,file);
  if(!fs.existsSync(p)){res.writeHead(404);return res.end('Not found')}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(p));
});
const wss=new WebSocket.Server({server,path:'/ws'});
function pair(code){if(!sessions.has(code))sessions.set(code,{controller:null,receiver:null});return sessions.get(code)}
function safeSend(ws,obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
wss.on('connection',(ws,req)=>{
 const q=new URL(req.url,'http://local').searchParams,role=q.get('role'),code=(q.get('code')||'').trim().toUpperCase();
 if(!code||!['controller','receiver'].includes(role)){ws.close(1008,'invalid session');return}
 const s=pair(code);s[role]=ws;
 const other=role==='controller'?s.receiver:s.controller;
 safeSend(ws,{type:'hello',version:'14.0.0',role,code});
 if(other){safeSend(other,{type:'session',state:'connected'});safeSend(ws,{type:'session',state:'connected'})}
 ws.on('message',raw=>{
   try{const m=JSON.parse(raw.toString());if(m.type==='input'&&role==='controller')safeSend(s.receiver,{type:'input',control:m.control,payload:m.payload||{},ts:m.ts||Date.now()})}catch{}
 });
 ws.on('close',()=>{if(s[role]===ws)s[role]=null;safeSend(other,{type:'session',state:'disconnected'})});
 ws.on('error',()=>{});
});
server.listen(PORT,HOST,()=>console.log(`Controle Nuvem V14 listening on ${PORT}`));