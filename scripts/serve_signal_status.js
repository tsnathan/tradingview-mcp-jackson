import http from 'node:http';
import { existsSync, readFileSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_FILE = join(ROOT, 'status', 'latest-signal-status.json');
const HTML_FILE = join(ROOT, 'dashboard', 'index.html');
const PORT = Number(process.env.SIGNAL_DASHBOARD_PORT || 3030);

function defaultStatus() {
  return {
    updatedAt: new Date().toISOString(),
    formattedTimestampEt: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date()),
    scanMode: 'signals_only',
    hasSignals: false,
    signalsFound: 0,
    changedSignals: 0,
    lines: [],
    summary: 'NO SIGNAL',
    skipped: false,
    reason: null,
    connectionError: false,
    errorMessage: null,
    symbolsScanned: 0,
    priorSignals: [],
  };
}

function getStatus() {
  if (!existsSync(STATUS_FILE)) return defaultStatus();
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return defaultStatus();
  }
}

const eventClients = new Set();

function pushEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(payload);
    } catch {
      eventClients.delete(client);
    }
  }
}

try {
  watch(join(ROOT, 'status'), (eventType, filename) => {
    if (!filename || String(filename) !== 'latest-signal-status.json') return;
    pushEvent({ type: 'status-updated', eventType, updatedAt: new Date().toISOString() });
  });
} catch {}

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getStatus(), null, 2));
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    eventClients.add(res);
    req.on('close', () => eventClients.delete(res));
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_FILE, 'utf8'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Signal dashboard running at http://127.0.0.1:${PORT}`);
});
