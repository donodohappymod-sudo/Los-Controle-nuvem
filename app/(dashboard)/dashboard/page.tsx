import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const [s,c,o,e]=await Promise.all([
    query('SELECT count(*)::int count FROM sources'),
    query('SELECT count(*)::int count FROM contents'),
    query("SELECT count(*)::int count FROM contents WHERE status='ONLINE'"),
    query("SELECT count(*)::int count FROM contents WHERE status IN ('ERRO','TIMEOUT')")
  ]);

  const stats=[
    ['FONTES',s.rows[0].count,'Fontes cadastradas'],
    ['CONTEÚDOS',c.rows[0].count,'Itens na biblioteca'],
    ['ONLINE',o.rows[0].count,'Último estado conhecido'],
    ['COM ERRO',e.rows[0].count,'Erro ou timeout']
  ];

  return <>
    <div className="hero"><div><div className="eyebrow">LOS COLLECTOR</div><h1 className="title">Painel operacional</h1><p className="sub">Visão rápida do seu ambiente de coleta e monitoramento.</p></div></div>
    <div className="grid4">{stats.map(x=><div className="card stat" key={x[0]}><div className="label">{x[0]}</div><div className="value">{x[1]}</div><div className="hint">{x[2]}</div></div>)}</div>
    <div className="grid2" style={{marginTop:16}}><div className="card"><div className="eyebrow">FLUXO</div><h3>Coleta → organização → diagnóstico</h3><p className="sub">Adicione uma fonte pública/autorizada, importe o conteúdo e acompanhe o estado dos URLs sem depender do Safari aberto.</p></div><div className="card"><div className="eyebrow">STUDIO</div><h3>Materiais promocionais</h3><p className="sub">Pesquise no TMDB, monte o projeto e use FFmpeg no servidor para gerar o vídeo.</p></div></div>
  </>;
}
