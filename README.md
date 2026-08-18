# Controle Nuvem V14 ULTRA

SaaS de controle remoto em tempo real com Node.js + WebSocket.

## Rodar
```bash
npm install
npm start
```

## Variáveis obrigatórias
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Opcionalmente:
- `PORT`
- `HOST`

## Rotas
- `/` — Controle Nuvem / controlador
- `/receiver?code=ABC123` — receptor
- `/admin` — painel administrativo
- `/api/health` — saúde do serviço
- `/api/public-config` — configurações públicas (sem segredos)

## Conexão
Abra o receiver com um código e use o mesmo código no controlador. A V14.2 corrige a entrada da sessão WebSocket e o encaminhamento dos comandos.

## Segurança
Nunca coloque senha administrativa, segredo de gateway, token privado ou chave secreta dentro de HTML/JavaScript público. Configure esses valores no ambiente do servidor.

## Social Gate
O frontend abre o Instagram configurado e registra a ação de continuar no dispositivo. Isso não é uma verificação real de follow; não há uma confirmação confiável de follow implementada neste fluxo.
