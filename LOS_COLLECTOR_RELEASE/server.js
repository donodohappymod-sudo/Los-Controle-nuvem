const { createServer } = require('http');
const next = require('next');
const { spawn } = require('child_process');
const app = next({ dev: false });
const handle = app.getRequestHandler();
const port = Number(process.env.PORT || 10000);
app.prepare().then(() => {
  createServer((req, res) => handle(req, res)).listen(port, '0.0.0.0', () => console.log(`LOS COLLECTOR listening on ${port}`));
}).catch((err) => { console.error(err); process.exit(1); });
