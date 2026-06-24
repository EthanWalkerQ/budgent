"use strict";
const $ = (s) => document.querySelector(s);
const PROGRAM = "H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM";
let ASSET = "SOL", RES = [];

const num = (n) => { const s = (Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6).toFixed(6); return s.replace(/\.?0+$/, "") || "0"; };
const short = (s) => { s = String(s || ""); return s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s; };
const cls = (st) => (st === "SETTLED" || st === "APPROVED") ? "ok" : st === "REVERTED" ? "bad" : st === "HELD" ? "hold" : "";
const glyph = (st) => (st === "SETTLED" || st === "APPROVED") ? "✓" : st === "REVERTED" ? "✗" : st === "HELD" ? "⏸" : "•";
const ext = (url) => (e) => { e.preventDefault(); window.budgent.openExternal(url); };

async function load() {
  try {
    const { vault, ledger, resources, armed } = await window.budgent.loadVault();
    ASSET = vault.asset || "SOL"; RES = resources || [];
    const st = vault.state || {}, p = vault.policy || {};
    $("#bal").textContent = num(st.balance); $("#asset").textContent = ASSET;
    $("#spent").textContent = `spent today ${num(st.spentInWindow)} / ${num(p.daily)} ${ASSET}`;
    const vl = $("#vault-link"); vl.textContent = short(vault.vaultPda); vl.onclick = ext(`https://solscan.io/account/${vault.vaultPda}`);
    $("#owner").textContent = short(vault.owner);
    $("#delegate").textContent = short(vault.delegate);
    const dot = $("#del-dot"); dot.className = "dot " + (vault.delegateActive ? "on" : "off");
    $("#p-pertx").textContent = num(p.perTx) + " " + ASSET;
    $("#p-daily").textContent = num(p.daily) + " " + ASSET;
    $("#p-cosign").textContent = num(p.cosign) + " " + ASSET;
    $("#p-allow").textContent = (p.allowlist || []).length + " / " + (p.blocklist || []).length;
    $("#domains").textContent = RES.length ? "domains: " + RES.map((r) => r.domain).join("  ·  ") : "";
    renderLedger(ledger || []);
    $("#pay-btn").disabled = !armed;
    $("#pay-btn").textContent = armed ? "Pay" : "Pay (read-only)";
  } catch (e) {
    $("#ledger").innerHTML = `<div class="empty">cannot reach backend: ${e.message}</div>`;
  }
}

function renderLedger(rows) {
  const el = $("#ledger");
  if (!rows.length) { el.innerHTML = '<div class="empty">// no payments yet</div>'; return; }
  el.innerHTML = "";
  rows.slice(0, 8).forEach((r) => {
    const c = cls(r.status);
    const dom = (r.context && r.context.domain) || short(r.recipient) || "—";
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML =
      `<span class="g ${c}">${glyph(r.status)}</span>` +
      `<span class="st ${c}">${r.status}</span>` +
      `<span>${num(r.amount)}</span>` +
      `<span class="dom">${dom}</span>` +
      (r.signature ? `<a href="#" class="sig">↗ ${short(r.signature)}</a>` : `<span style="color:var(--ink-2)">${(r.reason || "").slice(0, 16)}</span>`);
    if (r.signature) row.querySelector(".sig").onclick = ext(`https://solscan.io/tx/${r.signature}`);
    el.appendChild(row);
  });
}

async function pay() {
  const amount = Number($("#amount").value);
  const target = $("#target").value.trim();
  const cosign = $("#cosign").checked;
  const v = $("#verdict");
  if (!Number.isFinite(amount) || amount <= 0 || !target) { v.innerHTML = `<span class="bad">enter amount and recipient</span>`; return; }
  $("#pay-btn").disabled = true; v.innerHTML = `<span style="color:var(--ink-2)">signing → program executes on mainnet…</span>`;
  try {
    const r = await window.budgent.pay({ amount, target, cosign });
    const c = cls(r.status);
    let html = `<span class="${c}">${glyph(r.status)} ${r.status}</span> · ${num(r.amount)} ${r.asset || ASSET} → ${short(target)}`;
    if (r.reason) html += `<br><span style="color:var(--ink-2)">reason: ${r.reason}</span>`;
    if (r.signature) html += `<br><a href="#" id="vsig">↗ solscan: ${short(r.signature)}</a>`;
    v.innerHTML = html;
    if (r.signature) $("#vsig").onclick = ext(`https://solscan.io/tx/${r.signature}`);
    await load();
  } catch (e) {
    v.innerHTML = `<span class="bad">error: ${e.message}</span>`;
  } finally {
    $("#pay-btn").disabled = false;
  }
}

/* settings */
async function openSettings() {
  const c = await window.budgent.getConfig();
  $("#s-base").value = c.baseUrl; $("#s-vault").value = c.vaultId;
  $("#s-key").value = c.keyId; $("#s-hmac").value = c.hmacSecret;
  const armed = !!(c.keyId && c.hmacSecret);
  const a = $("#armed-state"); a.textContent = armed ? "● armed" : "read-only"; a.className = "armed" + (armed ? " on" : "");
  $("#settings").classList.remove("hidden");
}
async function saveSettings() {
  await window.budgent.setConfig({ baseUrl: $("#s-base").value.trim(), vaultId: $("#s-vault").value.trim(), keyId: $("#s-key").value.trim(), hmacSecret: $("#s-hmac").value.trim() });
  $("#settings").classList.add("hidden");
  await load();
}

$("#refresh").onclick = load;
$("#open-settings").onclick = openSettings;
$("#s-cancel").onclick = () => $("#settings").classList.add("hidden");
$("#s-save").onclick = saveSettings;
$("#pay-btn").onclick = pay;
$("#target").addEventListener("keydown", (e) => { if (e.key === "Enter") pay(); });
$("#amount").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#target").focus(); });

load();
