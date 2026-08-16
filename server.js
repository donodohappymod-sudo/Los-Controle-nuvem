const http=require('http'),fs=require('fs'),path=require('path'),WebSocket=require('ws');
const PORT=process.env.PORT||3000, sessions=new Map();
const server=http.createServer((req,res)=>{
 let file=req.url.startsWith('/receiver')?'receiver.html':'controller.html';
 if(req.url==='/')file='receiver.html';
 const p=path.join(__dirname,file);if(!fs.existsSync(p))return res.writeHead(404).end();
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(p));
});
const wss=new WebSocket.Server({server,path:'/ws'});
wss.on('connection',(ws,req)=>{
 const q=new URL(req.url,'http://local').searchParams,role=q.get('role'),code=q.get('code');
 if(!code)return ws.close();
 if(!sessions.has(code))sessions.set(code,{receiver:null,controller:null});
 const s=sessions.get(code);s[role]=ws;
 ws.on('message',m=>{if(role==='controller'&&s.receiver?.readyState===1)s.receiver.send(m.toString())});
 ws.on('close',()=>{if(s[role]===ws)s[role]=null;if(!s.receiver&&!s.controller)sessions.delete(code)});
});
server.listen(PORT,()=>console.log('http://localhost:'+PORT));
