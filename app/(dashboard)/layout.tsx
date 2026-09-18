'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import AppShell from '@/components/AppShell';

export default function Layout({children}:{children:React.ReactNode}){
  const router=useRouter();
  const [email,setEmail]=useState('');
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    let active=true;
    fetch('/api/auth/me',{cache:'no-store'})
      .then(async r=>{if(!r.ok) throw new Error('unauthorized'); return r.json();})
      .then(d=>{if(active)setEmail(d.user.email);})
      .catch(()=>{if(active)router.replace('/login');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[router]);
  if(loading)return <main style={{minHeight:'100vh',display:'grid',placeItems:'center'}}>Carregando LOS COLLECTOR…</main>;
  if(!email)return null;
  return <AppShell email={email}>{children}</AppShell>;
}
