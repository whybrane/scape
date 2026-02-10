#!/usr/bin/env node
/**
 * Moltly Agent Server – WebSocket relay for Agent Mode.
 * Scales to 100s of concurrent game+bot pairs on a single node.
 *
 * Env: AGENT_SERVER_PORT, MAX_CONNECTIONS, HEARTBEAT_MS, RATE_LIMIT_GAME, RATE_LIMIT_AGENT
 * Run: node scripts/agent_server.js
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.env.AGENT_SERVER_PORT) || 8080;
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 2000;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 30000;
const RATE_LIMIT_GAME = Number(process.env.RATE_LIMIT_GAME) || 25;
const RATE_LIMIT_AGENT = Number(process.env.RATE_LIMIT_AGENT) || 65;

const agents = new Map();
let totalConnections = 0;
let lastRateLimitReset = Date.now();
const connectionRate = new WeakMap();

function signChallenge(challenge, key) {
  let hash = 0;
  const combined = challenge + key;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function verifyChallenge(challenge, response, accessKey) {
  return response === signChallenge(challenge, accessKey);
}

function closeSafe(ws, code = 1000) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(code);
  } catch (_) {}
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    let games = 0, bots = 0;
    agents.forEach((a) => {
      if (a.gameWs && a.gameWs.readyState === WebSocket.OPEN) games++;
      if (a.agentWs && a.agentWs.readyState === WebSocket.OPEN) bots++;
    });
    res.end(JSON.stringify({
      connections: totalConnections,
      games,
      agents: bots,
      registeredAgents: agents.size,
      maxConnections: MAX_CONNECTIONS,
    }));
    return;
  }

  if (req.url === '/api/agents/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const agentId = (data.agentId || '').trim() || 'agent-' + crypto.randomBytes(4).toString('hex');
        const accessKey = crypto.randomBytes(16).toString('hex');
        agents.set(agentId, {
          accessKey,
          created: Date.now(),
          gameWs: null,
          agentWs: null,
        });
        res.end(JSON.stringify({
          success: true,
          agentId,
          accessKey,
          message: 'Agent registered. Use Agent ID + Access Key in Moltly Agent Mode.',
        }));
        if (agents.size % 50 === 0) console.log('[Server] Registered agents:', agents.size);
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/agents' && req.method === 'GET') {
    res.end(JSON.stringify({
      agents: Array.from(agents.keys()),
      count: agents.size,
      message: 'POST /api/agents/register with { agentId } to register.',
    }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocket.Server({ server, clientTracking: false });

wss.on('connection', (ws, req) => {
  if (totalConnections >= MAX_CONNECTIONS) {
    closeSafe(ws, 1013);
    return;
  }
  totalConnections++;
  let agentId = null;
  let role = null;
  let lastPing = Date.now();
  const rateCount = { n: 0 };

  const heartbeat = setInterval(() => {
    if (Date.now() - lastPing > HEARTBEAT_MS) {
      clearInterval(heartbeat);
      closeSafe(ws, 1000);
      return;
    }
    try {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    } catch (_) {}
  }, HEARTBEAT_MS / 2);

  ws.on('pong', () => { lastPing = Date.now(); });

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - lastRateLimitReset > 1000) {
      lastRateLimitReset = now;
      rateCount.n = 0;
    }
    const limit = role === 'agent' ? RATE_LIMIT_AGENT : RATE_LIMIT_GAME;
    if (role !== null && rateCount.n >= limit) return;
    rateCount.n++;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'auth') {
      const { agentId: id, challenge, response } = data;
      const agent = agents.get(id);
      if (!agent || !verifyChallenge(challenge, response, agent.accessKey)) {
        ws.send(JSON.stringify({ type: 'auth_response', status: 'failure', message: 'Invalid credentials' }));
        return;
      }
      agentId = id;
      role = data.role === 'agent' ? 'agent' : 'game';

      if (role === 'game') {
        if (agent.gameWs && agent.gameWs !== ws) closeSafe(agent.gameWs, 4000);
        agent.gameWs = ws;
      } else {
        if (agent.agentWs && agent.agentWs !== ws) closeSafe(agent.agentWs, 4000);
        agent.agentWs = ws;
      }
      ws.send(JSON.stringify({
        type: 'auth_response',
        status: 'success',
        sessionId: crypto.randomUUID(),
        role,
      }));
      if (totalConnections % 100 === 0) console.log('[Server] Connections:', totalConnections, '| Games+Agents:', agents.size);
      return;
    }

    if (!agentId) return;
    const agent = agents.get(agentId);
    if (!agent) return;

    if (role === 'game' && data.type === 'state') {
      if (agent.agentWs && agent.agentWs.readyState === WebSocket.OPEN) {
        agent.agentWs.send(JSON.stringify(data));
      }
      return;
    }

    if (role === 'agent' && (data.type === 'action' || (data.steer !== undefined && data.jump !== undefined))) {
      const payload = data.type === 'action' ? data : { type: 'action', ...data };
      if (agent.gameWs && agent.gameWs.readyState === WebSocket.OPEN) {
        agent.gameWs.send(JSON.stringify(payload));
      }
      return;
    }
  });

  ws.on('close', () => {
    totalConnections--;
    clearInterval(heartbeat);
    if (agentId) {
      const agent = agents.get(agentId);
      if (agent) {
        if (role === 'game' && agent.gameWs === ws) agent.gameWs = null;
        else if (role === 'agent' && agent.agentWs === ws) agent.agentWs = null;
      }
    }
  });

  ws.on('error', () => { clearInterval(heartbeat); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[Agent Server] Listening on port', PORT);
  console.log('[Agent Server] Max connections:', MAX_CONNECTIONS, '| Heartbeat:', HEARTBEAT_MS + 'ms');
  console.log('[Agent Server] Register: POST /api/agents/register');
  console.log('[Agent Server] Health: GET /health  |  Stats: GET /stats');
});
