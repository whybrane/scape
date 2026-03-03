# Arcade Agent Mode

This document explains how to connect an OpenClaw agent to `arcade.html` so it can drive the Arctic Panda bike. It is written for developers who want a reliable, production-grade integration (for Twitch, discord, labs, or any automated system)—not just casual players. The same steps will also work with other agent frameworks as long as they implement the WebSocket protocol described below.

## Quick overview

- The browser renders `arcade.html` and sends the agent’s actions in real time via `AgentController`.  
- A relay (`wss://scape-production-442e.up.railway.app` by default, or your own server) forwards game state to your bot and relays its steering/jump/boost decisions back to the browser.  
- The page includes an “Agent Mode” modal where you paste your Agent ID / Access Key and WebSocket endpoint, then click **Connect Agent** before starting the run.
- The server speaks plain JSON over WebSocket: you authenticate once, then receive ~20 state updates per second and respond with `{ steer, jump, boost, usePowerUp }`.

## Prerequisites

1. **Browser**: Any modern Chromium or WebKit browser that supports WebGL.  
2. **Agent credentials**: Required to connect to the relay.
   - Visit `/agent-register.html` (for example, `https://why.com/agent-register.html`) and click **Get credentials**. This returns the Agent ID and Access Key you paste into the modal.  
   - Alternatively, call the registration API (useful for scripting or CI):
     ```http
     POST https://scape-production-442e.up.railway.app/api/agents/register
     Content-Type: application/json

     { "agentId": "your-bot-name" }
     ```
     The response contains `accessKey` (keep it secret) and `agentId`.

## Connecting your OpenClaw operator

1. **Open the agent modal** in `arcade.html` and enter:
   - **Agent ID** and **Access Key** from the previous step.  
   - **Endpoint** (default `wss://scape-production-442e.up.railway.app`, or `ws://localhost:8080` when you run the local relay).  
2. Click **Connect Agent**. The page creates a `AgentController` instance and:
   - Opens a WebSocket to the endpoint.
   - Sends an `auth` message with a 256-bit hex challenge plus a hashed response (see “Challenge signing” below).
   - Starts broadcasting game state at ~50 ms intervals once authentication succeeds.
3. When the relay accepts the connection, it will forward every `state` packet to your bot, and your console logs (latency/actions per second) appear in the modal.

### Challenge signing (must match the server)

```
function signChallenge(challenge, accessKey) {
  let hash = 0;
  const combined = challenge + accessKey;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}
```

Your bot must calculate this exact hash and return it in the `response` field of the first message after opening the socket.

## Protocol details

### State payload (`type: "state"`, ~20 Hz)

```json
{
  "type": "state",
  "data": {
    "player": {
      "x": 0,
      "y": 0,
      "z": -100,
      "speed": 1.2,
      "isJumping": false,
      "hasPowerUp": false
    },
    "obstacles": [ { "x": 2, "z": -105, "type": "obstacle" }, { "x": -3, "z": -120, "type": "gap" } ],
    "coins": [ { "x": 0, "z": -110 } ],
    "powerUps": [],
    "score": 500,
    "level": 1,
    "biome": "arctic",
    "timestamp": 1234567890
  }
}
```

- `player.x`/`z`: lateral/forward position relative to the centerline (≈ -7 to 7).  
- `obstacles`: sorted by distance; `type` is `obstacle` (solid) or `gap`.  
- `coins`/`powerUps`: nearest pickups (x, z).  
- `score`, `level`, and `biome` for strategy/context.  
- `timestamp`: UNIX milliseconds for syncing timers or logging.

### Action payload (`steer` | `jump` | `boost` | `usePowerUp`)

Send any JSON object at `< 60` messages/second with these fields:

```json
{
  "steer": 0,            // -1 = hard left, 1 = hard right
  "jump": false,         // true = initiate a jump (gaps/obstacles)
  "boost": false,        // true = hold boost (level threshold applies)
  "usePowerUp": false    // true = activate current power-up
}
```

The `AgentController` smooths `steer` values and caches the latest frame so the physics loop never stalls even if you skip a frame.

## Running locally (optional)

1. Start the relay locally if you want to test without production credentials:
   ```bash
   node scripts/agent_server.js
   ```
   This exposes `ws://localhost:8080` (WebSocket) and the REST `POST /api/agents/register` endpoint used in the modal warnings.
2. Use the sample bot as a reference or baseline:
   ```bash
   AGENT_ID=moltly-bot AGENT_KEY=<accessKey> node scripts/moltly_agent_bot.js
   ```
   The script automatically registers (when `AGENT_KEY` is missing), connects, and logs steering decisions.
3. Point the browser modal endpoint to `ws://localhost:8080` and reuse the same credentials (the server pairs one agent + one game per ID).

## Observability and tooling

- `AgentController.updatePerformanceDisplay()` renders latency/actions per second into the modal (`#agent-latency`, `#agent-actions`).  
- `visualizeAgentBrain()` draws the state/action telemetry in `#brain-viz` whenever agent mode is active.  
- The modal also allows you to fallback to the built-in local agent (`setLocalAgentMode()`) for manual parameter tuning if the remote bot disconnects.

## Recommended next steps

1. Fork `scripts/moltly_agent_bot.js` or port its auth/loop logic into your OpenClaw operator stack.  
2. Push your credentials into secure storage (do not hardcode them into public repos).  
3. Upload your agent config to GitHub along with the `arcade.html` link and this README so other operators can replicate your setup.

## References

- `docs/MOLTLY_AGENT_BOT_GUIDE.md` for the original Moltly agent onboarding doc.  
- `scripts/agent_server.js` and `scripts/moltly_agent_bot.js` for relay + reference bot implementations.  
- `guide.html` / `agent-register.html` for production deployment guides (credential issuance, CLI examples).
