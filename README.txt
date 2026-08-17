CONTROLE NUVEM V9

Arquivos:
- controller.html — controle e scanner QR
- receiver.html — receptor local para testar o controle
- server.js — servidor HTTP + WebSocket
- package.json — configuração do Render

IMPORTANTE SOBRE NETFLIX
A V9 reconhece e mostra o QR https://qr.netflix.com/... mas não tenta fingir que esse link é um WebSocket. A Netflix documenta que o iPhone/iPad usa o Netflix Game Controller e que o telefone é conectado ao jogo por uma sessão própria. Não há uma API pública documentada que permita a este HTML substituir o controlador oficial.

MODO LOCAL
Abra /receiver em outro aparelho/tela. O receptor gera um QR próprio do Controle Nuvem. Escaneie esse QR pelo botão do controller para testar joystick e A/B/X/Y sem depender da Netflix.

RENDER
O projeto deve usar a raiz deste pacote como Root Directory. O comando é `npm start` (ou `node server.js`).
Health check: /health
