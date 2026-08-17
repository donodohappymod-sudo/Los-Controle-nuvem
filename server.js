const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||3000;
const HOST=process.env.HOST||'0.0.0.0';
const sessions=new Map();

const server=http.createServer((req,res)=>{
  let file;
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,service:'controle-nuvem',version:'9.0.0'}));}
  if(pathname.startsWith('/receiver')) file='receiver.html';
  else file='controller.html';

  const p=path.join(__dirname,file);
  if(!fs.existsSync(p)) return res.writeHead(404).end();

  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(fs.readFileSync(p));
});

const wss=new WebSocket.Server({server,path:'/ws'});

wss.on('connection',(ws,req)=>{
  const q=new URL(req.url,'http://local').searchParams;
  const role=q.get('role');
  const code=q.get('code');

  if(!code || (role!=='receiver' && role!=='controller')) return ws.close();

  if(!sessions.has(code)) sessions.set(code,{receiver:null,controller:null});
  const s=sessions.get(code);
  s[role]=ws;

  ws.on('message',m=>{
    if(role==='controller' && s.receiver && s.receiver.readyState===WebSocket.OPEN){
      s.receiver.send(m.toString());
    }
  });

  ws.on('close',()=>{
    if(s[role]===ws) s[role]=null;
    if(!s.receiver&&!s.controller) sessions.delete(code);
  });
});

server.listen(PORT,HOST,()=>console.log(`Controle Nuvem V9 rodando em ${HOST}:${PORT}`));