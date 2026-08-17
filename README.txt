CONTROLE NUVEM V14 — COMPLETE EDITION

Arquivos na raiz:
- controller.html — aplicativo completo do celular
- receiver.html — receptor do próprio Controle Nuvem
- server.js — servidor HTTP + WebSocket
- package.json

RENDER
Build Command: npm install
Start Command: npm start

V14 inclui:
- fluxo inicial completo
- scanner QR
- entrada manual de código
- sessão via WebSocket
- status real de servidor/receptor
- 10 designs de controle
- fundos animados em Canvas
- partículas, estrelas, HUD, grids, ondas e efeitos
- feedback visual nos botões
- joystick visual
- créditos © 2026 A Los Miguel
- Instagram @losmiguel_rs

TESTE DO RECEPTOR:
Abra /receiver?code=123456 na TV/navegador.
No celular, use "Entrar com código da sessão" e informe 123456.
Quando os dois estiverem conectados, o celular mostrará RECEIVER CONECTADO.

IMPORTANTE:
O WebSocket é a comunicação do próprio Controle Nuvem. O projeto não finge possuir uma API privada da Netflix. O QR da Netflix é apenas identificado pelo scanner; a conexão proprietária com Netflix Games continua sendo uma integração separada.
