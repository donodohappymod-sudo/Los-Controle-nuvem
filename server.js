const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '14.2.0';

const DATA_FILE = path.join(__dirname, 'data.json');
const sessions = new Map();
const adminSessions = new Map();

const defaultData = {
  settings: {
    siteName: 'Controle Nuvem',
    versionLabel: 'V14 ULTRA',
    socialGateEnabled: true,
    socialGateRequired: true,
    socialHandle: '@losmiguel_rs',
    supportEmail: 'contato@controlenuvem.com',
    supportWhatsapp: '',
    maintenanceMode: false
  },
  plans: [
    { id: 'free', name: 'Plano Grátis', price: 0, active: true, features: ['Controle completo', 'Social Gate', 'Recursos básicos', 'Com anúncios'] },
    { id: 'premium', name: 'Plano Premium', price: 19.90, active: true, features: ['Sem anúncios', '10 estilos de controle', 'Recursos exclusivos', 'Suporte prioritário'] }
  ],
  banners: [
    { id: 'home-1', title: 'Controle Nuvem V14 ULTRA', subtitle: 'Transforme seu celular em controle inteligente.', active: true }
  ],
  users: [],
  payments: {
    pixEnabled: true,
    cardEnabled: true,
    boletoEnabled: true,
    provider: '',
    publicKey: '',
    secretKey: '',
    webhook: ''
  },
  integrations: {
    sessionToken: '',
    receiverSecret: '',
    analyticsToken: '',
    netflixEnabled: false
  },
  audit: []
};

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
      return structuredClone(defaultData);
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...structuredClone(defaultData),
      ...parsed,
      settings: { ...defaultData.settings, ...(parsed.settings || {}) },
      payments: { ...defaultData.payments, ...(parsed.payments || {}) },
      integrations: { ...defaultData.integrations, ...(parsed.integrations || {}) }
    };
  } catch {
    return structuredClone(defaultData);
  }
}
let db = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function audit(action, meta = {}) {
  db.audit.unshift({ id: crypto.randomUUID(), action, meta, at: new Date().toISOString() });
  db.audit = db.audit.slice(0, 200);
  saveData();
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

function adminPasswordOk(password) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || typeof password !== 'string') return false;
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  const token = cookie(req, 'cn_admin');
  if (!token || !adminSessions.has(token)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return null;
  }
  return adminSessions.get(token);
}

function publicData() {
  return {
    settings: db.settings,
    plans: db.plans,
    banners: db.banners,
    users: db.users.map(u => ({ ...u, email: u.email ? maskEmail(u.email) : '' })),
    payments: {
      pixEnabled: db.payments.pixEnabled,
      cardEnabled: db.payments.cardEnabled,
      boletoEnabled: db.payments.boletoEnabled,
      provider: db.payments.provider,
      hasPublicKey: Boolean(db.payments.publicKey),
      hasSecretKey: Boolean(db.payments.secretKey),
      hasWebhook: Boolean(db.payments.webhook)
    },
    integrations: {
      hasSessionToken: Boolean(db.integrations.sessionToken),
      hasReceiverSecret: Boolean(db.integrations.receiverSecret),
      hasAnalyticsToken: Boolean(db.integrations.analyticsToken),
      netflixEnabled: false
    }
  };
}

function maskEmail(email) {
  const [a, b] = String(email).split('@');
  if (!b) return '***';
  return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '***') + '@' + b;
}

async function handleApi(req, res, u) {
  if (u.pathname === '/api/health') return json(res, 200, { ok: true, service: 'controle-nuvem', version: VERSION });
  if (u.pathname === '/api/public-config' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      settings: {
        siteName: db.settings.siteName,
        versionLabel: db.settings.versionLabel,
        socialGateEnabled: Boolean(db.settings.socialGateEnabled),
        socialGateRequired: Boolean(db.settings.socialGateRequired),
        socialHandle: db.settings.socialHandle || '@losmiguel_rs',
        maintenanceMode: Boolean(db.settings.maintenanceMode)
      },
      plans: db.plans.map(p => ({ id: p.id, name: p.name, price: p.price, active: p.active, features: p.features })),
      banners: db.banners.filter(b => b.active)
    });
  }

  if (u.pathname === '/api/admin/login' && req.method === 'POST') {
    try {
      const b = await body(req);
      const email = String(b.email || '').trim().toLowerCase();
      const expectedEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!expectedEmail || !adminPasswordOk(String(b.password || '')) || email !== expectedEmail) {
        return json(res, 401, { ok: false, error: 'Credenciais inválidas' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, { email, createdAt: Date.now() });
      audit('admin.login', { email });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `cn_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify({ ok: true }));
    } catch {
      return json(res, 400, { ok: false, error: 'Requisição inválida' });
    }
  }

  if (u.pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = cookie(req, 'cn_admin');
    if (token) adminSessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'cn_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (u.pathname === '/api/admin/me' && req.method === 'GET') {
    return json(res, 200, { ok: true, admin: { email: admin.email }, version: VERSION });
  }

  if (u.pathname === '/api/admin/data' && req.method === 'GET') {
    const response = publicData();
    response.stats = {
      users: db.users.length,
      premiumUsers: db.users.filter(u => u.plan === 'premium').length,
      activeSessions: [...sessions.values()].filter(s => s.controller || s.receiver).length,
      auditEvents: db.audit.length
    };
    response.audit = db.audit.slice(0, 40);
    return json(res, 200, response);
  }

  if (u.pathname === '/api/admin/config' && req.method === 'PUT') {
    try {
      const b = await body(req);
      if (b.settings) db.settings = { ...db.settings, ...b.settings };
      if (Array.isArray(b.plans)) db.plans = b.plans;
      if (Array.isArray(b.banners)) db.banners = b.banners;
      if (b.payments) {
        db.payments = {
          ...db.payments,
          ...Object.fromEntries(Object.entries(b.payments).filter(([k]) =>
            ['pixEnabled','cardEnabled','boletoEnabled','provider','publicKey','secretKey','webhook'].includes(k)
          ))
        };
      }
      if (b.integrations) {
        db.integrations = {
          ...db.integrations,
          ...Object.fromEntries(Object.entries(b.integrations).filter(([k]) =>
            ['sessionToken','receiverSecret','analyticsToken'].includes(k)
          ))
        };
      }
      saveData();
      audit('admin.config.updated', { sections: Object.keys(b) });
      return json(res, 200, { ok: true, data: publicData() });
    } catch {
      return json(res, 400, { ok: false, error: 'Configuração inválida' });
    }
  }

  if (u.pathname === '/api/admin/users' && req.method === 'POST') {
    try {
      const b = await body(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return json(res, 400, { ok: false, error: 'E-mail inválido' });
      const user = {
        id: crypto.randomUUID(),
        name: String(b.name || 'Usuário').slice(0, 80),
        email,
        plan: b.plan === 'premium' ? 'premium' : 'free',
        status: b.status === 'blocked' ? 'blocked' : 'active',
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      saveData();
      audit('admin.user.created', { id: user.id, plan: user.plan });
      return json(res, 201, { ok: true, user: { ...user, email: maskEmail(user.email) } });
    } catch {
      return json(res, 400, { ok: false, error: 'Usuário inválido' });
    }
  }

  if (u.pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
    const id = u.pathname.split('/').pop();
    try {
      const b = await body(req);
      const user = db.users.find(x => x.id === id);
      if (!user) return json(res, 404, { ok: false, error: 'Usuário não encontrado' });
      if (b.plan) user.plan = b.plan === 'premium' ? 'premium' : 'free';
      if (b.status) user.status = b.status === 'blocked' ? 'blocked' : 'active';
      if (b.name) user.name = String(b.name).slice(0, 80);
      saveData();
      audit('admin.user.updated', { id });
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { ok: false, error: 'Atualização inválida' });
    }
  }

  return json(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);

    let file = 'controller.html';
    if (u.pathname.startsWith('/receiver')) file = 'receiver.html';
    if (u.pathname === '/admin' || u.pathname.startsWith('/admin/')) file = 'admin.html';

    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) return json(res, 404, { ok: false, error: 'Not found' });
    const contentType = p.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(fs.readFileSync(p));
  } catch {
    json(res, 500, { ok: false, error: 'Internal error' });
  }
});

const wss = new WebSocket.Server({ server, path: '/ws' });

function pair(code) {
  if (!sessions.has(code)) sessions.set(code, { controller: null, receiver: null });
  return sessions.get(code);
}
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://local').searchParams;
  const role = q.get('role');
  const code = (q.get('code') || '').trim().toUpperCase();
  if (!code || !['controller', 'receiver'].includes(role)) {
    ws.close(1008, 'invalid session');
    return;
  }

  const s = pair(code);
  s[role] = ws;
  const other = role === 'controller' ? s.receiver : s.controller;

  safeSend(ws, { type: 'hello', version: VERSION, role, code });
  if (other) {
    safeSend(other, { type: 'session', state: 'connected' });
    safeSend(ws, { type: 'session', state: 'connected' });
  }

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ping') {
        safeSend(ws, { type: 'pong', time: Number(m.time) || Date.now() });
        return;
      }
      if (m.type === 'input' && role === 'controller') {
        safeSend(s.receiver, {
          type: 'input',
          control: String(m.control || 'unknown'),
          payload: m.payload || {},
          ts: m.ts || Date.now()
        });
      }
    } catch {}
  });

  ws.on('close', () => {
    if (s[role] === ws) s[role] = null;
    safeSend(other, { type: 'session', state: 'disconnected' });
  });
  ws.on('error', () => {});
});

server.listen(PORT, HOST, () => console.log(`Controle Nuvem V14 listening on ${PORT}`));
