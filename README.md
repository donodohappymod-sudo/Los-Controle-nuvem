# LOS COLLECTOR 4

Plataforma web para criar, coletar, organizar, diagnosticar, monitorar, mesclar e gerar fontes IPTV completas: canais, filmes, séries e episódios.

## Arquitetura
- Node.js 22 + HTTP API
- PostgreSQL em produção
- Sessão HttpOnly e senha com scrypt
- Render + Docker + FFmpeg
- Interface responsiva para Safari/iPhone, Chrome, Edge, Firefox e desktop

## Fluxo
Fontes → Coletor → Biblioteca → Diagnóstico → Monitoramento → Mesclar → Fontes Geradas → Studio.

## Segurança
Somente fontes públicas/autorizadas. O coletor não contorna login, CAPTCHA, DRM, paywall ou controles anti-bot. URLs privadas/localizadas são bloqueadas e redirecionamentos são revalidados.

## Deploy
Configure BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD, SESSION_SECRET e DATABASE_URL. A senha inicial vem apenas do ambiente e pode ser alterada dentro de Configurações.
