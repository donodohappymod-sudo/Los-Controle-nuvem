# LOS COLLECTOR SaaS

**Collect • Organize • Monitor**

Plataforma privada, responsiva e preparada para iPhone Safari para coletar, organizar, diagnosticar e monitorar conteúdo M3U/M3U8 público ou autorizado, com o **LOS COLLECTOR STUDIO** para materiais promocionais.

## Arquitetura

- Next.js 16 + React 19 + TypeScript
- PostgreSQL
- Docker
- FFmpeg no servidor
- TMDB API opcional para metadados do Studio
- Render Web Service + Cron Job + PostgreSQL
- armazenamento persistente configurável para uploads e vídeos gerados

## Módulos

- Login, sessão, logout e troca de senha
- Dashboard com fontes, conteúdos, online e erros
- Fontes: URL, validação, descoberta M3U/M3U8, crawl same-origin limitado e deduplicação
- Biblioteca: CANAIS, FILMES, SÉRIES, OUTRO; filtros e exportação M3U
- Diagnóstico: checks independentes com timeout
- Monitoramento server-side via Render Cron, sem depender do Safari aberto
- Studio: busca TMDB, preenchimento, capa, vídeo próprio/licenciado, formatos 9:16/16:9 e render real com FFmpeg
- Histórico do Studio e download dos MP4 gerados

## Segurança

- Nenhuma senha real é versionada.
- `BOOTSTRAP_ADMIN_PASSWORD` deve ser cadastrado como segredo no Render.
- Sessões são armazenadas por hash no PostgreSQL.
- URLs privadas/locais são bloqueadas pelo collector para reduzir SSRF.
- Não existe bypass de login, CAPTCHA, DRM, paywall ou controle de acesso.
- Uploads são limitados e armazenados fora do Git.

## Primeiro acesso

No Render, informe:

- `BOOTSTRAP_ADMIN_EMAIL=miguelalvesmillk@gmail.com`
- `BOOTSTRAP_ADMIN_PASSWORD=<senha inicial definida por você>`
- `TMDB_API_KEY=<sua chave>` se quiser o Studio TMDB

A senha fica somente nos secrets do Render. Depois do primeiro acesso, altere a senha em Configurações.

## Deploy no Render

O `render.yaml` já define o runtime Docker, banco PostgreSQL, disco persistente e job de monitoramento. O Render documenta que serviços Docker usam o `Dockerfile` e que cron jobs executam um comando agendado; os horários do cron são UTC. Veja a documentação oficial antes de alterar a infraestrutura.

1. Suba **o conteúdo deste projeto na raiz do repositório GitHub**.
2. No Render, crie o Blueprint a partir do `render.yaml`.
3. Preencha os segredos solicitados.
4. Aguarde Web Service + banco + Cron.
5. Abra a URL do Web Service no Safari.

## Testes locais

Sem instalar dependências, ainda é possível executar os testes estáticos fornecidos. Com dependências instaladas:

```bash
npm install
npm run typecheck
npm run test:core
npm run build
```

Para banco local:

```bash
export DATABASE_URL='postgresql://...'
npm run db:migrate
```

## Limitação de verificação deste pacote

O código é analisado e testado estaticamente neste ambiente. A execução real do `npm ci`, `next build`, conexão PostgreSQL, TMDB com chave real e deploy do Render depende de rede/credenciais externas e deve ser validada no ambiente de implantação. O pacote não declara como “testado” aquilo que não foi executado aqui.
