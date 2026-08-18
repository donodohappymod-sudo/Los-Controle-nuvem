# Controle Nuvem V14 ULTRA — Administração

## Executar
1. `npm install`
2. Copie `.env.example` para `.env` (ou configure as variáveis diretamente no provedor).
3. Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` no ambiente do servidor.
4. `npm start`
5. Abra `/admin` para o painel administrativo.

## O painel permite
- Visão geral e métricas
- Usuários e status
- Planos
- Banners e textos
- Social Gate
- PIX, cartão e boleto (camada de configuração; o gateway real precisa ser escolhido/configurado)
- Tokens e integrações
- Modo manutenção
- Sessões WebSocket
- Logs administrativos

## Segurança
- A senha administrativa não fica no HTML nem no JavaScript do navegador.
- Segredos de gateway/token não são devolvidos pela API; a interface mostra apenas se estão configurados.
- Não coloque senha bancária, CVV, senha de internet banking ou credenciais pessoais no projeto.
- Use um gateway de pagamento compatível e receba apenas os dados necessários ao processamento.
- A integração Netflix permanece desativada até ser implementada por uma API/fluxo oficial.

## Persistência
As configurações editadas no painel são salvas em `data.json`. Em produção, prefira um banco de dados e armazenamento de segredos do provedor de hospedagem.

## Sessão de controle
O WebSocket `/ws` e o fluxo de receptor continuam no projeto original. O painel administrativo não interfere no protocolo de controle.
