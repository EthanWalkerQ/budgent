#!/usr/bin/env node
/* ============================================================
   BUDGENT CLI — your wallet, your vault, on-chain budget.
   A fully self-serve, non-custodial CLI that drives the deployed
   Solana program (H9nJ…eV7yM) DIRECTLY with YOUR own keypair.
   No backend, no custody: you create the vault, fund it, set the
   policy, hand a delegate (the "agent") a budget — not your keys —
   and every payment is enforced on-chain. You can always withdraw.

   Owner key: --keypair <path> | BUDGENT_KEYPAIR | ~/.config/solana/id.json
   RPC:       BUDGENT_RPC (default https://api.mainnet-beta.solana.com)

   Commands:
     init   [--per-tx 0.05] [--daily 0.12] [--cosign 0.04] [--fee 0.02]
     status
     fund     <amount>
     allow    <pubkey>            block <pubkey>
     policy   [--per-tx] [--daily] [--cosign]
     pay      <amount> <recipient> [--cosign]
     withdraw <amount>            close
   ============================================================ */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
const BN = anchor.default?.BN ?? anchor.BN;   // BN lives on the CJS default in ESM interop
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDL = JSON.parse(readFileSync(join(HERE, "budgent_vault.json"), "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const MINT = PublicKey.default();                       // native-SOL sentinel
const RPC = process.env.BUDGENT_RPC || "https://api.mainnet-beta.solana.com";
const LAMPORTS = 1e9;
const CFG_DIR = join(HERE, ".budgent");
const CFG = join(CFG_DIR, "vault.json");

// ---------- ANSI ----------
const c = { r: "\x1b[0m", d: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", red: "\x1b[31m", y: "\x1b[33m", cy: "\x1b[36m", m: "\x1b[35m" };
const ok = (s) => console.log(`${c.g}✓${c.r} ${s}`);
const die = (s) => { console.error(`${c.red}✗ ${s}${c.r}`); process.exit(1); };
const sol = (lamports) => (Number(lamports) / LAMPORTS).toFixed(9).replace(/\.?0+$/, "") || "0";
const lam = (s) => Math.round(Number(s) * LAMPORTS);
const short = (s) => { s = String(s); return s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s; };
const tx = (sig) => `${c.cy}https://solscan.io/tx/${sig}${c.r}`;

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, def) => { const i = argv.indexOf("--" + name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : def; };

// ---------- keys / connection ----------
function loadOwner() {
  const path = flag("keypair") || process.env.BUDGENT_KEYPAIR || join(homedir(), ".config/solana/id.json");
  if (!existsSync(path)) die(`owner keypair not found at ${path}\n  pass --keypair <path> or set BUDGENT_KEYPAIR`);
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))); }
  catch (e) { die(`cannot read keypair ${path}: ${e.message}`); }
}
const connection = new Connection(RPC, "confirmed");
function progFor(signer) {
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  return new anchor.Program(IDL, provider);
}
function vaultPda(owner, vaultIdBN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), vaultIdBN.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
}

// ---------- config ----------
function saveCfg(obj) { if (!existsSync(CFG_DIR)) mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG, JSON.stringify(obj, null, 2)); }
function loadCfg() {
  if (!existsSync(CFG)) die("no vault yet — run `budgent init` first");
  const cfg = JSON.parse(readFileSync(CFG, "utf8"));
  cfg.delegateKp = Keypair.fromSecretKey(Uint8Array.from(cfg.delegateSecret));
  cfg.vaultIdBN = new BN(cfg.vaultId);
  cfg.pdaPk = new PublicKey(cfg.pda);
  return cfg;
}

// ---------- error decoding ----------
function explain(e) {
  const n = e?.error?.errorCode?.number ?? e?.code;
  const msg = e?.error?.errorMessage || e?.message || String(e);
  if (n != null && n >= 6000) return `program rejected (${n}): ${msg}`;
  return msg;
}

async function readVault(pda) {
  const program = progFor(Keypair.generate()); // read-only, signer irrelevant
  return program.account.vault.fetch(pda);
}
async function availLamports(pda) {
  const info = await connection.getAccountInfo(pda);
  if (!info) return 0;
  const rent = await connection.getMinimumBalanceForRentExemption(info.data.length);
  return Math.max(0, info.lamports - rent);
}

// ---------- commands ----------
async function init() {
  const owner = loadOwner();
  if (existsSync(CFG)) die(`a vault config already exists at ${CFG} — delete it to create a new one`);
  const perTx = lam(flag("per-tx", "0.05")), daily = lam(flag("daily", "0.12")), cosign = lam(flag("cosign", "0.04"));
  const feeReserve = lam(flag("fee", "0.02"));
  const vaultIdBN = new BN(randomBytes(7));        // < 2^56, fits u64 seed
  const delegate = Keypair.generate();
  const pda = vaultPda(owner.publicKey, vaultIdBN);

  console.log(`${c.b}Creating your vault${c.r}`);
  console.log(`  owner    ${owner.publicKey.toBase58()}`);
  console.log(`  vault    ${pda.toBase58()}  ${c.d}(id ${vaultIdBN.toString()})${c.r}`);
  console.log(`  delegate ${delegate.publicKey.toBase58()}  ${c.d}(the agent — gets a budget, not your keys)${c.r}`);
  console.log(`  policy   per-tx ${sol(perTx)} · daily ${sol(daily)} · co-sign ${sol(cosign)} SOL\n`);

  const program = progFor(owner);
  let sig = await program.methods
    .initializeVault(vaultIdBN, MINT, new BN(perTx), new BN(daily), new BN(cosign), delegate.publicKey)
    .accounts({ vault: pda, owner: owner.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  ok(`vault created → ${tx(sig)}`);

  // fund the delegate a dust reserve so it can pay its own tx fees
  const fundTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: delegate.publicKey, lamports: feeReserve }));
  const fsig = await sendAndConfirmTransaction(connection, fundTx, [owner]);
  ok(`delegate funded ${sol(feeReserve)} SOL for fees → ${tx(fsig)}`);

  saveCfg({ rpc: RPC, owner: owner.publicKey.toBase58(), vaultId: vaultIdBN.toString(), pda: pda.toBase58(), delegate: delegate.publicKey.toBase58(), delegateSecret: Array.from(delegate.secretKey) });
  console.log(`\n${c.d}saved → ${CFG}${c.r}`);
  console.log(`${c.y}next:${c.r} budgent fund 0.2   ·   budgent allow <recipient>   ·   budgent pay 0.01 <recipient>`);
}

async function status() {
  const cfg = loadCfg();
  const v = await readVault(cfg.pdaPk);
  const avail = await availLamports(cfg.pdaPk);
  const W = 60, line = (s) => console.log(`${c.d}│${c.r} ${s}`);
  console.log(`${c.d}┌─ BUDGENT VAULT · mainnet ${"─".repeat(W - 25)}┐${c.r}`);
  line(`vault    ${c.cy}${short(cfg.pda)}${c.r}  owner ${short(v.owner.toBase58())}`);
  line(`balance  ${c.b}${c.g}${sol(avail)} SOL${c.r}  spent window ${sol(v.spentInWindow)}/${sol(v.dailyLimit)}`);
  line(`delegate ${short(v.delegate.toBase58())} ${v.delegateActive ? c.g + "● active" : c.red + "● off"}${c.r}`);
  line(`policy   per-tx ${sol(v.perTxLimit)} · daily ${sol(v.dailyLimit)} · co-sign ${sol(v.cosignThreshold)} SOL`);
  line(`allow ${v.allowlist.length}  block ${v.blocklist.length}  paid ${sol(v.totalPaid)} (${v.paymentCount} tx)`);
  if (v.allowlist.length) line(`${c.d}allow: ${v.allowlist.map((p) => short(p.toBase58())).join(", ")}${c.r}`);
  if (v.blocklist.length) line(`${c.d}block: ${v.blocklist.map((p) => short(p.toBase58())).join(", ")}${c.r}`);
  console.log(`${c.d}└${"─".repeat(W + 1)}┘${c.r}`);
}

async function fund() {
  const cfg = loadCfg(); const owner = loadOwner();
  const amount = lam(pos[0]); if (!amount) die("usage: budgent fund <amount>");
  const program = progFor(owner);
  const sig = await program.methods.depositSol(new BN(amount))
    .accounts({ vault: cfg.pdaPk, depositor: owner.publicKey, systemProgram: SystemProgram.programId }).rpc();
  ok(`deposited ${sol(amount)} SOL → ${tx(sig)}`);
}

async function manage(kind, label) {
  const cfg = loadCfg(); const owner = loadOwner();
  const addr = new PublicKey(pos[0]); // throws if invalid
  const program = progFor(owner);
  const sig = await program.methods.manageList(kind, addr, true)
    .accounts({ vault: cfg.pdaPk, owner: owner.publicKey }).rpc();
  ok(`${label} ${short(addr.toBase58())} → ${tx(sig)}`);
}

async function policy() {
  const cfg = loadCfg(); const owner = loadOwner();
  const v = await readVault(cfg.pdaPk);
  const perTx = flag("per-tx") ? lam(flag("per-tx")) : Number(v.perTxLimit);
  const daily = flag("daily") ? lam(flag("daily")) : Number(v.dailyLimit);
  const cosign = flag("cosign") ? lam(flag("cosign")) : Number(v.cosignThreshold);
  const program = progFor(owner);
  const sig = await program.methods.setPolicy(new BN(perTx), new BN(daily), new BN(cosign))
    .accounts({ vault: cfg.pdaPk, owner: owner.publicKey }).rpc();
  ok(`policy set: per-tx ${sol(perTx)} · daily ${sol(daily)} · co-sign ${sol(cosign)} SOL → ${tx(sig)}`);
}

async function pay() {
  const cfg = loadCfg();
  const amount = lam(pos[0]); const recipient = pos[1];
  if (!amount || !recipient) die("usage: budgent pay <amount> <recipient> [--cosign]");
  const rcpt = new PublicKey(recipient);
  const cosign = !!flag("cosign");
  const ctxHash = createHash("sha256").update(`budgent:cli:${recipient}:${amount}:${Date.now()}`).digest(); // [u8;32]
  const program = progFor(cfg.delegateKp);                  // the agent signs + pays the fee

  const ix = await program.methods.paySol(new BN(amount), Array.from(ctxHash))
    .accounts({ vault: cfg.pdaPk, delegate: cfg.delegateKp.publicKey, recipient: rcpt, owner: new PublicKey(cfg.owner) })
    .instruction();

  const t = new Transaction();
  const signers = [cfg.delegateKp];
  if (cosign) {                                             // owner co-signs: flip its meta to signer
    const owner = loadOwner();
    const meta = ix.keys.find((k) => k.pubkey.equals(owner.publicKey));
    if (meta) meta.isSigner = true;
    signers.push(owner);
  }
  t.add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, t, signers, { commitment: "confirmed" });
    ok(`${c.b}SETTLED${c.r} ${sol(amount)} SOL → ${short(recipient)}  ${tx(sig)}`);
  } catch (e) {
    console.log(`${c.red}✗ REVERTED${c.r} ${sol(amount)} → ${short(recipient)}  ${c.d}${explain(e)}${c.r}`);
  }
}

async function withdraw() {
  const cfg = loadCfg(); const owner = loadOwner();
  const amount = lam(pos[0]); if (!amount) die("usage: budgent withdraw <amount>");
  const program = progFor(owner);
  const sig = await program.methods.withdrawSol(new BN(amount))
    .accounts({ vault: cfg.pdaPk, owner: owner.publicKey }).rpc();
  ok(`withdrew ${sol(amount)} SOL to owner → ${tx(sig)}`);
}

async function close() {
  const cfg = loadCfg(); const owner = loadOwner();
  const program = progFor(owner);
  const sig = await program.methods.closeVaultSol()
    .accounts({ vault: cfg.pdaPk, owner: owner.publicKey }).rpc();
  ok(`vault closed — full balance returned to owner → ${tx(sig)}`);
}

const HELP = `${c.b}budgent${c.r} — your wallet, your vault, on-chain budget (mainnet)

  ${c.cy}init${c.r}   [--per-tx 0.05] [--daily 0.12] [--cosign 0.04] [--fee 0.02]
  ${c.cy}status${c.r}
  ${c.cy}fund${c.r}     <amount>
  ${c.cy}allow${c.r}    <pubkey>          ${c.cy}block${c.r} <pubkey>
  ${c.cy}policy${c.r}   [--per-tx N] [--daily N] [--cosign N]
  ${c.cy}pay${c.r}      <amount> <recipient> [--cosign]
  ${c.cy}withdraw${c.r} <amount>          ${c.cy}close${c.r}

owner key: --keypair <path> | BUDGENT_KEYPAIR | ~/.config/solana/id.json
rpc:       BUDGENT_RPC (default mainnet-beta)`;

(async () => {
  try {
    switch (cmd) {
      case "init": return await init();
      case "status": return await status();
      case "fund": return await fund();
      case "allow": return await manage(0, "allowlisted");
      case "block": return await manage(1, "blocklisted");
      case "policy": return await policy();
      case "pay": return await pay();
      case "withdraw": return await withdraw();
      case "close": return await close();
      default: console.log(HELP);
    }
  } catch (e) { die(explain(e)); }
})();
