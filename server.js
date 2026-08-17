const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');
const PORT=process.env.PORT||3000;
const HOST=process.env.HOST||'0.0.0.0';
const sessions=new Map();
function send(res,status,type,body){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);}
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/health') return send(res,200,'application/json',JSON.stringify({ok:true,service:'controle-nuvem',version:'10.0.0'}));
  const file=pathname.startsWith('/receiver')?'receiver.html':'controller.html';
  const p=path.join(__dirname,file);
  if(!fs.existsSync(p))return send(res,404,'text/plain','Not found');
  send(res,200,'text/html; charset=utf-8',fs.readFileSync(p));
});
const wss=new WebSocket.Server({server,path:'/ws'});
wss.on('connection',(ws,req)=>{
  const q=new URL(req.url,'http://local').searchParams;
  const role=q.get('role'),code=q.get('code');
  if(!code||!['receiver','controller'].includes(role))return ws.close();
  if(!sessions.has(code))sessions.set(code,{receiver:null,controller:null});
  const s=sessions.get(code);s[role]=ws;
  if(role==='controller'&&s.receiver?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'session',state:'connected'}));
  if(role==='receiver'&&s.controller?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'session',state:'connected'}));
  ws.on('message',m=>{
    const target=role==='controller'?s.receiver:s.controller;
    if(target?.readyState===WebSocket.OPEN)target.send(m.toString());
  });
  ws.on('close',()=>{if(s[role]===ws)s[role]=null;if(!s.receiver&&!s.controller)sessions.delete(code)});
});
server.listen(PORT,HOST,()=>console.log(`Controle Nuvem V10 SaaS rodando em ${HOST}:${PORT}`));