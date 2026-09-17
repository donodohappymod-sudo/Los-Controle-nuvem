# LOS COLLECTOR — verificação do pacote

## Verificado neste ambiente

- Estrutura Next.js com diretório real `app/` e rotas dentro dele.
- `package.json` na raiz.
- `render.yaml` na raiz.
- `Dockerfile` na raiz.
- Arquivos de ambiente e ignore com nomes corretos (`.env.example`, `.gitignore`, `.dockerignore`).
- Smoke test estrutural (`tests/core.mjs`) disponível.
- Fallback `RECONSTRUCT_PROJECT.mjs` + `prebuild` incluído para o caso de uma ferramenta de upload achatar os nomes das pastas.
- Dockerfile não depende mais do script de reconstrução para um projeto com pastas reais.

## Não declarado como testado aqui

Este ambiente não conseguiu concluir `npm install` por falta de acesso/tempo de rede para o registry. Portanto, **não** declaro `next build`, TypeScript completo, PostgreSQL real, TMDB real, FFmpeg real ou deploy do Render como aprovados.

O primeiro teste no Render deve ser o build Docker/Next. Com a estrutura correta, o erro anterior `Couldn't find any pages or app directory` deixa de ser esperado.
