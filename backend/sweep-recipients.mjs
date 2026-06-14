// Recover all SOL sent to the demo "vendor" wallets back to the owner.
// Vendor keypairs were saved at .keys/recipients.json during setup.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const env = Object.fromEntries(readFileSync(resolve(__dir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const conn = new Connection(env.RPC_URL, 'confirmed');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(ROOT, '.keys/owner.json'), 'utf8')))).publicKey;
const recips = JSON.parse(readFileSync(resolve(ROOT, '.keys/recipients.json'), 'utf8'));
const FEE = 5000;

let total = 0;
for (const [domain, r] of Object.entries(recips)) {
  const kp = Keypair.fromSecretKey(Uint8Array.from(r.secret));
  const bal = await conn.getBalance(kp.publicKey, 'confirmed');
  if (bal <= FEE) { console.log(`  ${domain}: ${bal / 1e9} SOL — nothing to sweep`); continue; }
  const amount = bal - FEE;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: owner, lamports: amount }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey; tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  total += amount;
  console.log(`  ${domain}: swept ${amount / 1e9} SOL → owner  (${sig.slice(0, 12)}…)`);
}
console.log(`\n✓ recovered ${total / 1e9} SOL to owner ${owner.toBase58()}`);
