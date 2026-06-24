#!/usr/bin/env node
/* ============================================================
   BUDGENT WALLET — terminal TUI
   A real, non-custodial agent wallet in your terminal. It reads
   live vault state from the chain (public endpoints) and sends
   REAL on-chain payments through the published `budgent-sdk` →
   the deployed program enforces the budget. No mocks.

   Config (env or wallet-tui/.env):
     BUDGENT_BASE_URL   default https://budgent.money
     BUDGENT_VAULT_ID   the vault to operate
     BUDGENT_KEY_ID     scoped api key id      (needed to send)
     BUDGENT_HMAC_SECRET  the key's hmac secret (needed to send)
   ============================================================ */
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BudgentClient } from "budgent-sdk";

// ---------- tiny .env loader (no deps) ----------
const HERE = dirname(fileURLToPath(import.meta.url));
(function loadEnv() {
  const f = join(HERE, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const BASE = process.env.BUDGENT_BASE_URL || "https://budgent.money";
const VAULT = process.env.BUDGENT_VAULT_ID || "";
const KEY_ID = process.env.BUDGENT_KEY_ID || "";
const HMAC = process.env.BUDGENT_HMAC_SECRET || "";
const PROGRAM = "H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM";

if (!VAULT) {
  console.error("Set BUDGENT_VAULT_ID (env or wallet-tui/.env). See README.md");
  process.exit(1);
}

const sdk = KEY_ID && HMAC ? new BudgentClient({ baseUrl: BASE, keyId: KEY_ID, hmacSecret: HMAC }) : null;

// ---------- ANSI ----------
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", b: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", mag: "\x1b[35m", gray: "\x1b[90m", white: "\x1b[97m",
};
const W = 64; // inner width
const clear = () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
const pad = (s, n) => { s = String(s); const len = visLen(s); return len >= n ? s : s + " ".repeat(n - len); };
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const short = (s) => (s && s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s || "—");
const top = (t) => { const lbl = `─ ${t} `; return `${C.gray}┌${lbl}${"─".repeat(Math.max(0, W - visLen(lbl)))}┐${C.reset}`; };
const mid = (t) => { const lbl = `─ ${t} `; return `${C.gray}├${lbl}${"─".repeat(Math.max(0, W - visLen(lbl)))}┤${C.reset}`; };
const bot = (t = "") => { const s = t ? ` ${t} ` : ""; const dashes = W - visLen(s); const l = Math.floor(dashes / 2); return `${C.gray}└${"─".repeat(l)}${C.cyan}${s}${C.gray}${"─".repeat(dashes - l)}┘${C.reset}`; };
const row = (s) => `${C.gray}│${C.reset} ${pad(s, W - 2)} ${C.gray}│${C.reset}`;

// ---------- data ----------
const api = async (path) => {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};
const num = (n) => {
  const s = (Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
};

let RES = [];
async function fetchAll() {
  const [vault, ledger, resources] = await Promise.all([
    api(`/v1/public/vaults/${VAULT}`),
    api(`/v1/public/vaults/${VAULT}/ledger`).catch(() => []),
    api(`/v1/public/vaults/${VAULT}/resources`).catch(() => []),
  ]);
  RES = resources || [];
  return { vault, ledger: ledger || [] };
}

// ---------- render ----------
function glyph(status) {
  if (status === "SETTLED" || status === "APPROVED") return `${C.green}✓${C.reset}`;
  if (status === "REVERTED") return `${C.red}✗${C.reset}`;
  if (status === "HELD") return `${C.yellow}⏸${C.reset}`;
  return `${C.gray}•${C.reset}`;
}
function statusColor(s) {
  if (s === "SETTLED" || s === "APPROVED") return C.green;
  if (s === "REVERTED") return C.red;
  if (s === "HELD") return C.yellow;
  return C.white;
}

function render(vault, ledger) {
  const st = vault.state || {};
  const p = vault.policy || {};
  const asset = vault.asset || "SOL";
  const lines = [];
  lines.push(top(`${C.b}${C.white}BUDGENT WALLET${C.reset}${C.gray}  non-custodial · mainnet`));
  lines.push(row(`${C.dim}vault    ${C.reset}${C.cyan}${short(vault.vaultPda)}${C.reset}   ${C.dim}owner ${short(vault.owner)}   [${asset}]${C.reset}`));
  lines.push(row(`${C.dim}balance  ${C.reset}${C.b}${C.green}${num(st.balance)} ${asset}${C.reset}   ${C.dim}spent today ${num(st.spentInWindow)}/${num(p.daily)}${C.reset}`));
  const dot = vault.delegateActive ? `${C.green}●${C.reset}` : `${C.red}●${C.reset}`;
  lines.push(row(`${C.dim}delegate ${C.reset}${short(vault.delegate)} ${dot}${C.dim}   program ${short(PROGRAM)}${C.reset}`));

  lines.push(mid("POLICY"));
  lines.push(row(`${C.dim}per-tx cap${C.reset}  ${pad(num(p.perTx) + " " + asset, 14)}${C.dim}co-sign over${C.reset} ${num(p.cosign)} ${asset}`));
  lines.push(row(`${C.dim}daily limit${C.reset} ${pad(num(p.daily) + " " + asset, 14)}${C.dim}allow ${C.reset}${(p.allowlist || []).length}  ${C.dim}block ${C.reset}${(p.blocklist || []).length}`));

  lines.push(mid("LEDGER · real on-chain"));
  if (!ledger.length) lines.push(row(`${C.dim}// no payments yet${C.reset}`));
  else ledger.slice(0, 6).forEach((r) => {
    const sc = statusColor(r.status);
    const dom = (r.context && r.context.domain) || short(r.recipient) || "—";
    const tail = r.signature ? `${C.cyan}↗ ${short(r.signature)}${C.reset}` : `${C.dim}${(r.reason || "").slice(0, 18)}${C.reset}`;
    lines.push(row(`${glyph(r.status)} ${pad(sc + r.status + C.reset, 9)} ${pad(num(r.amount), 7)} ${pad(dom, 20)} ${tail}`));
  });

  lines.push(mid("SEND · domains"));
  let doms = RES.map((r) => r.domain).join("  ") || "—";
  if (doms.length > W - 2) doms = doms.slice(0, W - 3) + "…";
  lines.push(row(`${C.dim}${doms}${C.reset}`));
  const armed = sdk ? `${C.green}● armed${C.reset}` : `${C.yellow}● read-only (set key in .env)${C.reset}`;
  lines.push(row(armed));
  lines.push(bot(`${C.b}pay <amt> <domain>${C.reset}${C.cyan}  ·  r refresh  ·  q quit`));
  clear();
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------- pay ----------
async function doPay(args) {
  if (!sdk) { msg(`${C.yellow}read-only:${C.reset} set BUDGENT_KEY_ID + BUDGENT_HMAC_SECRET in wallet-tui/.env to send (see README).`); return; }
  const amount = Number(args[0]);
  const target = args[1];
  if (!Number.isFinite(amount) || amount <= 0 || !target) { msg(`${C.red}usage:${C.reset} pay <amount> <domain|pubkey>`); return; }
  const isPubkey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target) && !target.includes(".");
  const input = isPubkey ? { amount, recipient: target } : { amount, domain: target };
  input.taskId = "wallet-tui";
  input.idempotencyKey = `tui-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  msg(`${C.dim}signing HMAC → POST /v1/payments → program executes on mainnet…${C.reset}`);
  try {
    const r = await sdk.pay(input);
    const sc = statusColor(r.status);
    let out = `${glyph(r.status)} ${C.b}${sc}${r.status}${C.reset}  ${num(r.amount)} ${r.asset || "SOL"} → ${target}`;
    if (r.reason) out += `\n   ${C.dim}reason:${C.reset} ${r.reason}`;
    if (r.signature) out += `\n   ${C.cyan}solscan: https://solscan.io/tx/${r.signature}${C.reset}`;
    if (Array.isArray(r.ruleResults)) {
      const rr = r.ruleResults.filter((x) => x.status !== "skip").map((x) => `${x.status === "pass" ? C.green + "✓" : C.red + "✗"} ${x.rule}${C.reset}`).join("  ");
      if (rr) out += `\n   ${rr}`;
    }
    msg(out);
  } catch (e) {
    msg(`${C.red}error:${C.reset} ${e.message}`);
  }
}

let lastMsg = "";
function msg(s) { lastMsg = s; }

// ---------- loop ----------
const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => { closed = true; });
const ask = (q) => new Promise((res) => { if (closed) return res(""); rl.question(q, res); });

async function loop() {
  for (;;) {
    if (closed) break;
    let data;
    try { data = await fetchAll(); }
    catch (e) { clear(); console.log(`${C.red}cannot reach ${BASE}${C.reset}: ${e.message}`); break; }
    if (closed) break;
    render(data.vault, data.ledger);
    if (lastMsg) { process.stdout.write("\n" + lastMsg + "\n"); lastMsg = ""; }
    const line = (await ask(`\n${C.mag}budgent ▸${C.reset} `)).trim();
    if (closed) break;
    if (!line) continue;
    const [cmd, ...args] = line.split(/\s+/);
    if (cmd === "q" || cmd === "quit" || cmd === "exit") break;
    if (cmd === "r" || cmd === "refresh") continue;
    if (cmd === "pay") { await doPay(args); continue; }
    if (cmd === "help" || cmd === "h") { msg(`${C.dim}commands:${C.reset} pay <amount> <domain|pubkey> · r refresh · q quit`); continue; }
    msg(`${C.red}unknown:${C.reset} ${cmd}  ${C.dim}(try: pay 0.01 gpu.inference.io · r · q)${C.reset}`);
  }
  rl.close();
  clear();
  console.log(`${C.cyan}budgent wallet closed.${C.reset} funds remain fully withdrawable by the owner.\n`);
}

loop();
