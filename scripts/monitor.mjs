import pg from 'pg';
const {Pool}=pg;
const db=process.env.DATABASE_URL;if(!db){console.error('DATABASE_URL ausente');process.exit(1)}
const pool=new Pool({connectionString:db,ssl:{rejectUnauthorized:false}});
const raw=(process.env.APP_URL||'').replace(/\/$/,''); const base=raw.startsWith('http://')||raw.startsWith('https://')?raw:`http://${raw}`;const secret=process.env.JOB_SECRET||'';
try{if(!base||!secret)throw new Error('APP_URL/JOB_SECRET ausentes');const r=await fetch(`${base}/api/jobs/monitor`,{method:'POST',headers:{'x-job-secret':secret}});console.log(await r.text());if(!r.ok)process.exit(1)}finally{await pool.end()}
