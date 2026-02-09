#!/usr/bin/env node
/**
 * Local PoC bot for Moltly Agent Mode.
 * Connects to agent_server as "agent", receives game state, sends steer/jump/boost/usePowerUp.
 *
 * Usage:
 *   1. Start server: node scripts/agent_server.js
 *   2. Register (or use existing key): curl -X POST http://localhost:8080/api/agents/register -H "Content-Type: application/json" -d '{"agentId":"moltly-bot"}'
 *   3. Run bot: AGENT_ID=moltly-bot AGENT_KEY=<accessKey> node scripts/moltly_agent_bot.js
 *   4. In browser: open moltly.html → Agent Mode → same Agent ID + Access Key → Connect → ARCTIC RUN
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const ENDPOINT = process.env.AGENT_ENDPOINT || 'http://localhost:8080';
const AGENT_ID = process.env.AGENT_ID || 'moltly-bot';
const AGENT_KEY = process.env.AGENT_KEY || '';

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

function register() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/agents/register', ENDPOINT);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.success) resolve({ agentId: data.agentId, accessKey: data.accessKey });
          else reject(new Error(data.message || body));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ agentId: AGENT_ID }));
    req.end();
  });
}

function runBot(agentId, accessKey) {
  const wsUrl = ENDPOINT.replace(/^http/, 'ws');
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    const challenge = Array.from(crypto.randomBytes(32)).map(b => b.toString(16).padStart(2, '0')).join('');
    ws.send(JSON.stringify({
      type: 'auth',
      role: 'agent',
      agentId,
      challenge,
      response: signChallenge(challenge, accessKey),
      timestamp: Date.now(),
    }));
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'auth_response') {
      if (data.status !== 'success') {
        console.error('Auth failed:', data.message);
        process.exit(1);
      }
      console.log('Bot authenticated. Waiting for game state...');
      return;
    }
    if (data.type !== 'state' || !data.data) return;
    const state = data.data;
    const player = state.player || {};
    const obstacles = state.obstacles || [];
    const coins = state.coins || [];
    const px = player.x != null ? player.x : 0;
    const pz = player.z != null ? player.z : 0;

    // Find nearest obstacle ahead (smallest distance in x-z plane; prefer ones in front)
    const roadHalf = 7;
    let nearestObstacle = null;
    let nearestDist = Infinity;
    for (const o of obstacles) {
      const ox = o.x != null ? o.x : 0;
      const oz = o.z != null ? o.z : 0;
      const dz = pz - oz;
      const dist = Math.sqrt((ox - px) ** 2 + dz ** 2);
      if (dist < nearestDist && dz > -2 && dz < 25) {
        nearestDist = dist;
        nearestObstacle = { ...o, dx: ox - px, dz, dist };
      }
    }

    let steer = 0;
    const inPath = nearestObstacle && Math.abs(nearestObstacle.dx) < 2;
    const distZ = nearestObstacle ? Math.abs(nearestObstacle.dz) : 20;

    if (nearestObstacle && inPath && distZ < 15) {
      // Avoid: steer away from obstacle (left if obstacle is on right, etc.)
      const avoid = nearestObstacle.dx > 0 ? -0.9 : 0.9;
      steer = avoid;
      // If we're already past it laterally, also nudge toward center
      if (Math.abs(px) > 3) steer += px > 0 ? -0.3 : 0.3;
    } else {
      // No close obstacle: steer toward center
      if (px > 0.5) steer = -0.5;
      else if (px < -0.5) steer = 0.5;
    }
    steer = Math.max(-1, Math.min(1, steer));

    const jump = inPath && distZ < 10 && distZ > 0.5 && nearestObstacle;
    const usePowerUp = Boolean(player.hasPowerUp && inPath && distZ < 12);
    const boost = state.level >= 2 && Math.random() < 0.03;

    if (Math.random() < 0.02) {
      const action = steer !== 0 ? (steer > 0 ? 'RIGHT' : 'LEFT') : 'straight';
      console.log(`[Bot] px=${px.toFixed(1)} obstacles=${obstacles.length} nearest=${nearestObstacle ? nearestDist.toFixed(1) : '-'} steer=${action} jump=${jump}`);
    }

    ws.send(JSON.stringify({
      steer,
      jump,
      boost,
      usePowerUp,
    }));
  });

  ws.on('error', (err) => { console.error('WebSocket error:', err.message); });
  ws.on('close', () => { console.log('Bot disconnected'); process.exit(0); });
}

async function main() {
  let agentId = AGENT_ID;
  let accessKey = AGENT_KEY;
  if (!accessKey) {
    console.log('No AGENT_KEY; registering...');
    const r = await register();
    agentId = r.agentId;
    accessKey = r.accessKey;
    console.log('Registered. Use in Moltly: Agent ID =', agentId, 'Access Key =', accessKey);
  }
  runBot(agentId, accessKey);
}

main().catch((e) => { console.error(e); process.exit(1); });
