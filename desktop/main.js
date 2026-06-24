/* ============================================================
   BUDGENT DESKTOP — Electron main process.
   Owns all network: live on-chain reads (public endpoints) and
   REAL payments through the published budgent-sdk. The renderer
   never sees the HMAC secret. No mocks.
   ============================================================ */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { BudgentClient } = require("budgent-sdk");

const DEFAULTS = { baseUrl: "https://budgent.money", vaultId: "cmqif4af40000e9birfj0zp8h", keyId: "", hmacSecret: "" };
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadEnvFile() {
  const f = path.join(__dirname, ".env");
  const out = {};
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function getConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch {}
  const e = loadEnvFile();
  return {
    baseUrl: saved.baseUrl || process.env.BUDGENT_BASE_URL || e.BUDGENT_BASE_URL || DEFAULTS.baseUrl,
    vaultId: saved.vaultId || process.env.BUDGENT_VAULT_ID || e.BUDGENT_VAULT_ID || DEFAULTS.vaultId,
    keyId: saved.keyId || process.env.BUDGENT_KEY_ID || e.BUDGENT_KEY_ID || "",
    hmacSecret: saved.hmacSecret || process.env.BUDGENT_HMAC_SECRET || e.BUDGENT_HMAC_SECRET || "",
  };
}

async function api(base, p) {
  const r = await fetch(base + p, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

ipcMain.handle("config:get", () => getConfig());
ipcMain.handle("config:set", (_e, cfg) => {
  const cur = getConfig();
  const next = { baseUrl: cfg.baseUrl || cur.baseUrl, vaultId: cfg.vaultId || cur.vaultId, keyId: cfg.keyId ?? cur.keyId, hmacSecret: cfg.hmacSecret ?? cur.hmacSecret };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return getConfig();
});
ipcMain.handle("vault:load", async () => {
  const c = getConfig();
  const [vault, ledger, resources] = await Promise.all([
    api(c.baseUrl, `/v1/public/vaults/${c.vaultId}`),
    api(c.baseUrl, `/v1/public/vaults/${c.vaultId}/ledger`).catch(() => []),
    api(c.baseUrl, `/v1/public/vaults/${c.vaultId}/resources`).catch(() => []),
  ]);
  return { vault, ledger, resources, armed: !!(c.keyId && c.hmacSecret) };
});
ipcMain.handle("pay", async (_e, { amount, target, cosign }) => {
  const c = getConfig();
  if (!c.keyId || !c.hmacSecret) throw new Error("not armed — add your key in Settings");
  const sdk = new BudgentClient({ baseUrl: c.baseUrl, keyId: c.keyId, hmacSecret: c.hmacSecret });
  const isPubkey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target) && !target.includes(".");
  const input = isPubkey ? { amount, recipient: target } : { amount, domain: target };
  input.taskId = "budgent-desktop";
  input.idempotencyKey = `desk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return sdk.pay(input);
});
ipcMain.handle("open:external", (_e, url) => shell.openExternal(url));

function createWindow() {
  const win = new BrowserWindow({
    width: 940, height: 760, minWidth: 780, minHeight: 580,
    backgroundColor: "#0B0814", title: "Budgent",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
