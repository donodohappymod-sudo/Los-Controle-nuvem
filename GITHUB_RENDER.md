# GitHub → Render

## Importante

O GitHub não descompacta um ZIP automaticamente. O repositório precisa receber a **estrutura de arquivos e pastas**, com `package.json` e `render.yaml` na raiz.

## Render

Este projeto usa `runtime: docker` no Blueprint. Isso evita o problema anterior em que o Render tentou executar `gunicorn` para um projeto que não era um app WSGI Python.

O Dockerfile instala FFmpeg, executa a migração do PostgreSQL e inicia o Next.js em `0.0.0.0:10000`.

## Segredos

Nunca coloque em GitHub:

- senha do usuário
- SESSION_SECRET
- JOB_SECRET
- TMDB_API_KEY
- DATABASE_URL com senha

O Blueprint marca os segredos para preenchimento privado.
