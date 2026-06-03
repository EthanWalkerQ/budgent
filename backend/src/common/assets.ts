import { NATIVE_MINT_SENTINEL } from './units';

export interface AssetSpec {
  asset: string; // display symbol
  mint: string; // sentinel for native SOL, else SPL mint
  decimals: number;
}

export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const KNOWN: Record<string, AssetSpec> = {
  SOL: { asset: 'SOL', mint: NATIVE_MINT_SENTINEL, decimals: 9 },
  USDC: { asset: 'USDC', mint: USDC_MAINNET, decimals: 6 },
};

/** Resolve an asset request to {symbol, mint, decimals}. */
export function resolveAsset(input: { asset?: string; mint?: string; decimals?: number }): AssetSpec {
  if (input.asset && KNOWN[input.asset.toUpperCase()]) return KNOWN[input.asset.toUpperCase()];
  if (input.mint) {
    if (input.mint === NATIVE_MINT_SENTINEL) return KNOWN.SOL;
    if (input.mint === USDC_MAINNET) return KNOWN.USDC;
    return { asset: input.asset || 'TOKEN', mint: input.mint, decimals: input.decimals ?? 0 };
  }
  return KNOWN.SOL;
}
