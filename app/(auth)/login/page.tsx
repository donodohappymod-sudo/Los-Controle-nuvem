'use client';

import { FormEvent, useState } from 'react';

export default function Login(){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);

  async function submit(e:FormEvent){
    e.preventDefault();
    if(loading) return;
    setLoading(true);
    setError('');
    try{
      const response=await fetch('/api/auth/login',{
        method:'POST',
        credentials:'same-origin',
        cache:'no-store',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({email:email.trim(),password}),
      });
      const raw=await response.text();
      let data:any={};
      try{data=raw?JSON.parse(raw):{};}catch{}
      if(!response.ok){
        setError(data?.error||'Não foi possível entrar. Tente novamente.');
        setLoading(false);
        return;
      }
      // Full navigation forces every browser to send the newly-created HttpOnly session cookie.
      window.location.replace('/dashboard');
    }catch{
      setError('Falha de conexão com o servidor. Verifique a internet e tente novamente.');
      setLoading(false);
    }
  }

  return <main className="login">
    <section className="loginBox">
      <div className="loginBrand">
        <div className="crown">♛</div>
        <div><b>LOS COLLECTOR</b><small style={{display:'block',color:'var(--muted)',fontSize:9,letterSpacing:'.14em'}}>COLLECT • ORGANIZE • MONITOR</small></div>
      </div>
      <div className="eyebrow">PRIVATE SAAS</div>
      <h1 className="title">Acesso ao painel</h1>
      <p className="sub" style={{marginBottom:22}}>Centralize fontes, biblioteca, diagnóstico, monitoramento e Studio.</p>
      {error&&<div className="error" style={{marginBottom:12}}>{error}</div>}
      <form className="form" onSubmit={submit}>
        <label>E-mail<input className="input" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={email} onChange={e=>setEmail(e.target.value)} required /></label>
        <label>Senha<input className="input" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>
        <button className="btn primary" type="submit" disabled={loading}>{loading?'ENTRANDO…':'ENTRAR'}</button>
      </form>
    </section>
  </main>;
}
