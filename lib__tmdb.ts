export async function tmdbSearch(query:string,type:'movie'|'tv'='movie'){
  const key=process.env.TMDB_API_KEY; if(!key) throw new Error('TMDB_API_KEY não configurada.');
  const endpoint=type==='movie'?'movie':'tv'; const u=`https://api.themoviedb.org/3/search/${endpoint}?api_key=${encodeURIComponent(key)}&language=pt-BR&query=${encodeURIComponent(query)}&include_adult=false`;
  const r=await fetch(u,{next:{revalidate:300}}); if(!r.ok) throw new Error(`TMDB HTTP ${r.status}`); const data=await r.json();
  return (data.results||[]).slice(0,12).map((x:any)=>({id:x.id,title:x.title||x.name||'',year:(x.release_date||x.first_air_date||'').slice(0,4),description:x.overview||'',cover:x.poster_path?`https://image.tmdb.org/t/p/w780${x.poster_path}`:'',genres:[]}));
}
export async function tmdbDetails(id:string,type:'movie'|'tv'){ const key=process.env.TMDB_API_KEY; if(!key) throw new Error('TMDB_API_KEY não configurada.'); const r=await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${encodeURIComponent(key)}&language=pt-BR`); if(!r.ok) throw new Error(`TMDB HTTP ${r.status}`); return r.json(); }
