// UniFi Live Flows (2026-11-17) -- the gateway's live (active) connections for Home Assistant.
//
// The Network app's Flows > Live view reads them over WebRTC. This does the same:
//   login (local UniFi admin)            POST /api/auth/login
//   TURN credentials                     cmd/cloudaccess get-turn-credentials
//   ask the gateway for a session        cmd/devmgr build-ssh-session  (channel_type trafficflow)
//   SDP offer arrives on the events ws   wss .../wss/s/<site>/events   message device:sdp-offer
//   answer                               cmd/devmgr ssh-sdp-answer
//   data channel "trafficflow.1"         JSON-RPC lines: {"id","method":"get_flows","params":{"page","page_size"}}
//   names (client, network, zone)        POST v2 traffic-flows/enrich
// The session stays open while Home Assistant keeps asking, and closes after idle_seconds.
//
// HTTP API (port 8099):
//   GET /flows   -> {snapshot_time, count, total, took_ms, records: [...]}   records shaped like the v2 traffic-flows log
//   GET /health  -> {ok, session, last_error}
// The password is never logged.
"use strict";
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const WebSocket = require("ws");
const ndc = require("node-datachannel");

const OPTS = JSON.parse(fs.readFileSync(process.env.OPTIONS_FILE || "/data/options.json", "utf8"));
if (process.env.UNIFI_USERNAME) OPTS.username = process.env.UNIFI_USERNAME;   // local testing only
if (process.env.UNIFI_PASSWORD) OPTS.password = process.env.UNIFI_PASSWORD;
const HOST = OPTS.host || "10.0.1.1";
const SITE = OPTS.site || "default";
const PAGE = OPTS.page_size || 100;
const MAX = OPTS.max_flows || 3000;
const IDLE_MS = (OPTS.idle_seconds || 120) * 1000;
const PORT = +(process.env.PORT || 8099);
const LABEL = "trafficflow.1";
const PROTO = { 1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6", 132: "SCTP" };
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });   // the UDM's certificate is self-signed

const log = (...a) => console.log(new Date().toISOString(), ...a);
let lastError = "";

// ---------------------------------------------------------------- REST
const auth = { cookie: "", csrf: "" };
function rest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: "application/json" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (auth.csrf) headers["X-CSRF-Token"] = auth.csrf;
    const req = https.request({ host: HOST, port: 443, path, method, headers, agent, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const set = res.headers["set-cookie"];
        if (set) {
          const tok = set.map((c) => c.split(";")[0]).find((c) => c.startsWith("TOKEN="));
          if (tok) auth.cookie = tok;
        }
        const t = res.headers["x-updated-csrf-token"] || res.headers["x-csrf-token"];
        if (t) auth.csrf = t;
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout " + path)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  if (!OPTS.username || !OPTS.password) throw new Error("username/password not set in the app options");
  auth.cookie = ""; auth.csrf = "";
  const r = await rest("POST", "/api/auth/login", { username: OPTS.username, password: OPTS.password, rememberMe: false, token: "" });
  if (r.status !== 200) throw new Error("login failed: HTTP " + r.status);
  log("logged in");
}

// REST call that logs in again once on 401
async function api(method, path, body) {
  if (!auth.cookie) await login();
  let r = await rest(method, path, body);
  if (r.status === 401) { await login(); r = await rest(method, path, body); }
  return r;
}
const net = (p) => `/proxy/network${p}`;
const cmd = (mgr, body) => api("POST", net(`/api/s/${SITE}/cmd/${mgr}`), body);

let gatewayMac = OPTS.gateway_mac || "";
async function findGateway() {
  if (gatewayMac) return gatewayMac;
  const r = await api("GET", net(`/api/s/${SITE}/stat/device`));
  const devs = (r.json && r.json.data) || [];
  const gw = devs.find((d) => d.ip === HOST) || devs.find((d) => /^(udm|ugw|uxg)/.test(d.type || ""));
  if (!gw) throw new Error("gateway not found in stat/device; set gateway_mac");
  gatewayMac = gw.mac;
  log("gateway", gw.name || gw.model, gatewayMac);
  return gatewayMac;
}

// ---------------------------------------------------------------- session
class Session {
  constructor() { this.id = crypto.randomUUID(); this.rpc = 0; this.pending = new Map(); this.buf = ""; this.open = false; }

  async start() {
    const mac = await findGateway();
    const t = await cmd("cloudaccess", { cmd: "get-turn-credentials" });
    if (t.status !== 200) throw new Error("get-turn-credentials: HTTP " + t.status + " (needs a Network admin login)");
    const turn = ((t.json && t.json.data) || [{}])[0] || {};
    const uris = turn.uris || turn.urls || [];
    const pick = (p) => (uris.find((u) => u.startsWith(p + ":")) || "").replace(p + ":", "").replace("?transport=udp", "");

    const offer = new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${HOST}${net(`/wss/s/${SITE}/events?clients=v2`)}`,
        { headers: { Cookie: auth.cookie, Origin: `https://${HOST}` }, rejectUnauthorized: false });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("no SDP offer from the gateway")), 25000);
      ws.on("message", (m) => {
        let j; try { j = JSON.parse(m.toString()); } catch (e) { return; }
        if (j.meta && j.meta.message === "device:sdp-offer") {
          const d = (j.data || [])[0] || {};
          if (d.ssh_sdp_offer_id === this.id) { clearTimeout(timer); resolve(d.ssh_sdp_offer); }
        }
      });
      ws.on("close", (code, why) => { if (!this.open) { clearTimeout(timer); reject(new Error("events websocket closed: " + why)); } });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
      ws.on("open", async () => {
        const r = await cmd("devmgr", { cmd: "build-ssh-session", mac, uuid: this.id, stun: pick("stun"), turn: pick("turn"),
          username: turn.username || "", password: turn.password || "", ttl: "-1", channel_type: "trafficflow" });
        if (r.status !== 200) { clearTimeout(timer); reject(new Error("build-ssh-session: HTTP " + r.status)); }
      });
    });
    const sdp = await offer;

    await new Promise((resolve, reject) => {
      const pc = new ndc.PeerConnection("unifi-live-flows", { iceServers: [] });   // the gateway's LAN candidate is enough
      this.pc = pc;
      let answered = false;
      const timer = setTimeout(() => reject(new Error("data channel did not open")), 25000);
      pc.onGatheringStateChange(async (s) => {
        if (s === "complete" && !answered) {
          answered = true;
          const r = await cmd("devmgr", { cmd: "ssh-sdp-answer", mac, uuid: this.id, sdpanswer: pc.localDescription().sdp });
          if (r.status !== 200) { clearTimeout(timer); reject(new Error("ssh-sdp-answer: HTTP " + r.status)); }
        }
      });
      pc.onStateChange((s) => { if (s === "failed" || s === "closed") this.open = false; });
      pc.setRemoteDescription(sdp, "offer");
      const dc = pc.createDataChannel(LABEL);
      this.dc = dc;
      dc.onOpen(() => { clearTimeout(timer); this.open = true; resolve(); });
      dc.onClosed(() => { this.open = false; });
      dc.onMessage((m) => this.onData(typeof m === "string" ? m : Buffer.from(m).toString()));
    });
    log("session open", this.id.slice(0, 8));
  }

  onData(s) {
    this.buf += s;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      const p = this.pending.get(j.id);
      if (p) { this.pending.delete(j.id); clearTimeout(p.timer); j.error ? p.reject(new Error(JSON.stringify(j.error))) : p.resolve(j.result); }
    }
  }

  call(method, params) {
    if (!this.open) return Promise.reject(new Error("session not open"));
    const id = ++this.rpc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.dc.sendMessage(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async close() {
    this.open = false;
    try { this.pc && this.pc.close(); } catch (e) { /* ignore */ }
    try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
    try { await cmd("devmgr", { cmd: "close-ssh-session", mac: gatewayMac, uuid: this.id }); } catch (e) { /* ignore */ }
    log("session closed", this.id.slice(0, 8));
  }
}

let session = null, starting = null, idleTimer = null;
async function getSession() {
  if (session && session.open) return session;
  if (starting) return starting;
  starting = (async () => {
    if (session) { await session.close(); session = null; }
    const s = new Session();
    try { await s.start(); } catch (e) { await s.close(); throw e; }
    session = s;
    return s;
  })().finally(() => { starting = null; });
  return starting;
}
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { if (session) { await session.close(); session = null; } }, IDLE_MS);
}

// ---------------------------------------------------------------- flows + names
const names = new Map();   // flow_id -> {source, destination, direction, at}
const NAME_TTL = 10 * 60000;

async function enrich(flows) {
  const now = Date.now();
  const todo = flows.filter((f) => { const n = names.get(String(f.flow_id)); return !n || now - n.at > NAME_TTL; });
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200);
    const body = { flows: batch.map((f) => ({ ip: { saddr: f.ip.saddr, daddr: f.ip.daddr, sport: f.ip.sport, dport: f.ip.dport,
      protocol: f.ip.protocol }, ref: String(f.flow_id), in: String(f.in || ""), out: String(f.out || "") })) };
    const r = await api("POST", net(`/v2/api/site/${SITE}/traffic-flows/enrich`), body);
    const got = (r.json && r.json.flows) || [];
    got.forEach((g, k) => {
      const ref = g.ref !== undefined ? String(g.ref) : String(batch[k] && batch[k].flow_id);
      names.set(ref, { source: g.source || {}, destination: g.destination || {}, direction: g.direction || "", at: now });
    });
  }
  for (const [k, v] of names) if (now - v.at > 3 * NAME_TTL) names.delete(k);
}

function record(f) {
  const n = names.get(String(f.flow_id)) || { source: {}, destination: {} };
  const ip = f.ip || {};
  // The gateway counts routes between two of its LAN bridges (e.g. br0 -> br40, Default -> CAM) the other way
  // round: on 11/17 all 17 Frigate camera pulls on br0 -> br40 showed the video as tx, while the same pulls over
  // the gate tunnel (-> wgsts1000) and internet flows (-> eth8) were right. Bytes and packets are swapped back here.
  const swapped = /^br/.test(f.in || "") && /^br/.test(f.out || "");
  const raw = f.stats || {};
  const st = swapped ? { txBytes: raw.rxBytes, rxBytes: raw.txBytes, txPackets: raw.rxPackets, rxPackets: raw.txPackets } : raw;
  const end = Date.parse(f.timestamp) || Date.now(), start = Date.parse(f.flow_start) || end;
  return {
    id: String(f.flow_id), live: true, status: f.status, state: f.state, in_iface: f.in, out_iface: f.out, counters_swapped: swapped,
    source: Object.assign({ ip: ip.saddr }, n.source, { port: ip.sport }),
    // f.hostnames = the gateway's own DNS-snooped name(s) for this flow's destination (on ~60% of live flows);
    // they come first, ahead of whatever traffic-flows/enrich found.
    destination: Object.assign({ ip: ip.daddr }, n.destination, { port: ip.dport,
      domains: [...new Set([...(Array.isArray(f.hostnames) ? f.hostnames : []), ...((n.destination || {}).domains || [])])].filter(Boolean) }),
    protocol: PROTO[ip.protocol] || String(ip.protocol), direction: n.direction || "", action: "allowed",
    application: f.dpi || null, service: "",
    traffic_data: { bytes_tx: st.txBytes || 0, bytes_rx: st.rxBytes || 0, packets_tx: st.txPackets || 0, packets_rx: st.rxPackets || 0,
      bytes_total: (st.txBytes || 0) + (st.rxBytes || 0) },
    flow_start_time: start, flow_end_time: end, time: end, duration_milliseconds: end - start,
  };
}

let cache = null;
async function snapshot() {
  if (cache && Date.now() - cache.at < 3000) return cache.body;
  const t0 = Date.now();
  const s = await getSession();
  touch();
  const flows = [];
  let total = 0;
  for (let page = 0; flows.length < MAX; page++) {
    const r = await s.call("get_flows", { page, page_size: PAGE });
    const got = (r && r.flows) || [];
    total = r && r.total !== undefined ? r.total : total;
    flows.push(...got);
    if (got.length < PAGE || (total && flows.length >= total)) break;
  }
  await enrich(flows);
  const body = { snapshot_time: Date.now(), count: flows.length, total, truncated: flows.length >= MAX, took_ms: Date.now() - t0,
    records: flows.map(record) };
  cache = { at: Date.now(), body };
  return body;
}

// ---------------------------------------------------------------- HTTP
http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (req.url.startsWith("/health")) return send(200, { ok: true, session: !!(session && session.open), last_error: lastError });
    if (req.url.startsWith("/flows")) {
      try {
        const b = await snapshot();
        lastError = "";
        return send(200, b);
      } catch (e) {
        lastError = String(e.message || e);
        log("flows failed:", lastError);
        if (session) { await session.close(); session = null; }
        return send(502, { error: lastError });
      }
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
}).listen(PORT, () => log(`UniFi Live Flows on :${PORT}, gateway ${HOST}, site ${SITE}`));

async function shutdown() {
  if (session) await session.close();
  if (auth.cookie) { try { await rest("POST", "/api/auth/logout"); } catch (e) { /* ignore */ } }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
