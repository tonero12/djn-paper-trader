/**
 * @file server/dexscreener/adapter.ts
 * DEX Screener market data adapter with caching, deduplication, URL parsing, and chain detection
 */

import { DexQuote, SupportedChain, TokenMetadata } from '../types.js';
import { D } from '../utils/decimal.js';

interface CachedEntry {
  quote: DexQuote;
  cachedAt: number;
}

export class DexScreenerAdapter {
  private cache: Map<string, CachedEntry> = new Map();
  private inflight: Map<string, Promise<DexQuote | null>> = new Map();
  private cacheTtlMs: number = 8000; // 8 seconds cache for fresh live prices without hitting rate limits

  /**
   * Safely parses user input which can be:
   * 1. A recognized DEX Screener URL: e.g. https://dexscreener.com/solana/... or https://dexscreener.com/ronin/...
   * 2. A chain + address syntax: e.g. "ronin 0x..." or "solana 4k..."
   * 3. A Ronin prefix address: e.g. ronin:0x... or ronin:...
   * 4. A Solana base58 contract address (32-44 characters)
   * 5. An EVM contract address (0x followed by 40 hex characters)
   */
  public parseInput(input: string, fallbackChain: SupportedChain = 'solana'): {
    address: string;
    chain?: SupportedChain;
    isUrl: boolean;
    isPairUrl?: boolean;
    ambiguousEvm?: boolean;
  } | null {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    // 1. Check for recognized DEX Screener URL on any chain
    const dexscreenerUrlMatch = trimmed.match(/^https?:\/\/(?:www\.)?dexscreener\.com\/([a-zA-Z0-9_\-]+)\/([a-zA-Z0-9_]+)/i);
    if (dexscreenerUrlMatch) {
      const rawChain = dexscreenerUrlMatch[1].toLowerCase();
      const addressOrPair = dexscreenerUrlMatch[2];
      const normalizedChain = this.normalizeChain(rawChain);
      return {
        address: addressOrPair,
        chain: normalizedChain,
        isUrl: true,
        isPairUrl: true,
      };
    }

    // 2. Check for "chain address" syntax, e.g. "ronin 0x123..." or "robin 0x123..." or "base 0x..."
    const spaceParts = trimmed.split(/\s+/);
    if (spaceParts.length === 2) {
      const maybeChain = this.normalizeChain(spaceParts[0]);
      const maybeAddr = spaceParts[1];
      if (/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(maybeAddr)) {
        return {
          address: maybeAddr,
          chain: maybeChain,
          isUrl: false,
        };
      }
    }

    // 3. Check for chain-prefixed address e.g. "ronin:0x...", "arbitrum:0x...", "base:0x...", etc.
    const colonMatch = trimmed.match(/^([a-zA-Z0-9_\-]+):(.+)$/);
    if (colonMatch) {
      const parsedChain = this.normalizeChain(colonMatch[1]);
      let rawAddr = colonMatch[2].trim();
      if (parsedChain === 'ronin' && !rawAddr.startsWith('0x') && /^[a-fA-F0-9]{40}$/i.test(rawAddr)) {
        rawAddr = `0x${rawAddr}`;
      }
      if (/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(rawAddr)) {
        return {
          address: parsedChain === 'solana' ? rawAddr : rawAddr.toLowerCase(),
          chain: parsedChain,
          isUrl: false,
        };
      }
    }

    // 4. Check for standard EVM address (0x...)
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return {
        address: trimmed.toLowerCase(),
        ambiguousEvm: true, // Can be Base, Ethereum, Ronin, BSC, Arbitrum, Polygon, etc.
        isUrl: false,
      };
    }

    // 5. Check for Solana base58 address (preserve case!)
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      return {
        address: trimmed,
        chain: 'solana',
        isUrl: false,
      };
    }

    return null;
  }

  public normalizeChain(chainStr: string): string {
    if (!chainStr) return 'solana';
    const lower = chainStr.toLowerCase().trim();
    if (lower === 'solana' || lower === 'sol') return 'solana';
    if (lower === 'ronin' || lower === 'robin' || lower === 'ron') return 'ronin';
    if (lower === 'base') return 'base';
    if (lower === 'ethereum' || lower === 'eth' || lower === 'ether') return 'ethereum';
    if (lower === 'bsc' || lower === 'binance' || lower === 'bnb') return 'bsc';
    if (lower === 'arbitrum' || lower === 'arb') return 'arbitrum';
    if (lower === 'polygon' || lower === 'matic' || lower === 'poly') return 'polygon';
    if (lower === 'avalanche' || lower === 'avax') return 'avalanche';
    if (lower === 'sui') return 'sui';
    if (lower === 'ton') return 'ton';
    if (lower === 'optimism' || lower === 'op') return 'optimism';
    if (lower === 'blast') return 'blast';
    if (lower === 'pulsechain' || lower === 'pulse') return 'pulsechain';
    if (lower === 'fantom' || lower === 'ftm' || lower === 'sonic') return 'fantom';
    if (lower === 'cronos' || lower === 'cro') return 'cronos';
    if (lower === 'mantle') return 'mantle';
    if (lower === 'linea') return 'linea';
    if (lower === 'zksync') return 'zksync';
    return lower.replace(/[^a-z0-9_-]/g, '') || 'solana';
  }

  /**
   * Fetch token quote by token address and chain
   */
  public async getTokenQuote(tokenAddress: string, chain: SupportedChain, specificPairAddress?: string): Promise<DexQuote | null> {
    const pairKey = `${chain}:${tokenAddress}${specificPairAddress ? ':' + specificPairAddress : ''}`;
    const baseKey = `${chain}:${tokenAddress}`;

    // Check cache
    const now = Date.now();
    const cached = this.cache.get(pairKey) || this.cache.get(baseKey);
    if (cached && (now - cached.cachedAt) < this.cacheTtlMs) {
      return cached.quote;
    }

    const cacheKey = pairKey;
    // Check inflight request to deduplicate concurrent queries
    if (this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey)!;
    }

    const fetchPromise = this.fetchFromDexScreener(tokenAddress, chain, specificPairAddress)
      .then((result) => {
        if (result) {
          this.cache.set(cacheKey, { quote: result, cachedAt: Date.now() });
        }
        return result;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  /**
   * Internal fetcher calling DEX Screener API
   */
  private async fetchFromDexScreener(
    tokenAddress: string,
    chain: SupportedChain,
    specificPairAddress?: string
  ): Promise<DexQuote | null> {
    try {
      let endpoint: string;

      if (specificPairAddress) {
        endpoint = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${specificPairAddress}`;
      } else {
        endpoint = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DJN-Paper-Trader-Bot/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[DEX Screener] Non-OK status ${response.status} for ${endpoint}`);
        return null;
      }

      const data = await response.json();
      let pairs: any[] = [];

      if (specificPairAddress && data.pair) {
        pairs = [data.pair];
      } else if (Array.isArray(data.pairs)) {
        pairs = data.pairs;
      }

      if (!pairs || pairs.length === 0) {
        return null;
      }

      // Filter for matching chain
      let eligiblePairs = pairs.filter((p) => {
        if (!chain || chain === 'auto' || chain === 'any') return true;
        const pChain = this.normalizeChain(p.chainId || '');
        return pChain === chain;
      });

      // If no pairs found for the requested chain, fallback to any available pair across any chain
      if (eligiblePairs.length === 0) {
        eligiblePairs = pairs;
      }

      if (eligiblePairs.length === 0) {
        return null;
      }

      // Sort eligible pairs by USD liquidity descending to always pick the primary market pool
      eligiblePairs.sort((a, b) => {
        const liqA = Number(a.liquidity?.usd) || 0;
        const liqB = Number(b.liquidity?.usd) || 0;
        return liqB - liqA;
      });

      // Find best eligible pair:
      // Must have priceUsd. Prefer where token is baseToken and highest liquidity.
      let bestPair = eligiblePairs.find((p) => {
        const pChain = this.normalizeChain(p.chainId || '');
        const isBase = pChain === 'solana'
          ? p.baseToken?.address === tokenAddress
          : p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase();
        return isBase && p.priceUsd && parseFloat(p.priceUsd) > 0;
      });

      // If not found as baseToken with positive price, try first pair with price
      if (!bestPair) {
        bestPair = eligiblePairs.find((p) => p.priceUsd && parseFloat(p.priceUsd) > 0);
      }

      if (!bestPair || !bestPair.priceUsd) {
        return null;
      }

      const detectedChain = this.normalizeChain(bestPair.chainId || (chain as string) || 'solana');

      // Determine token metadata from the best pair
      const isBaseToken = detectedChain === 'solana'
        ? bestPair.baseToken?.address === tokenAddress
        : bestPair.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase();

      const matchedTokenInfo = isBaseToken ? bestPair.baseToken : bestPair.quoteToken;

      const tokenMeta: TokenMetadata = {
        address: tokenAddress,
        chain: detectedChain,
        name: matchedTokenInfo?.name || bestPair.baseToken?.name || 'Unknown Token',
        symbol: matchedTokenInfo?.symbol || bestPair.baseToken?.symbol || 'UNKNOWN',
        imageUrl: bestPair.info?.imageUrl || undefined,
        pairAddress: bestPair.pairAddress,
        dexId: bestPair.dexId || 'dex',
        pairCreatedAt: bestPair.pairCreatedAt ? Number(bestPair.pairCreatedAt) : undefined,
        url: bestPair.url,
      };

      // Ensure price is quoted for the requested token
      // If token is baseToken, bestPair.priceUsd is directly its USD price
      let tokenPriceUsd = bestPair.priceUsd;
      if (!isBaseToken && bestPair.priceNative && bestPair.priceUsd) {
        // Fallback calculation if inverted:
        // In most memecoin pairs, the memecoin is baseToken. If inverted, price = priceUsd / priceNative or as reported
        const price = D(bestPair.priceUsd);
        if (price.gt(0)) {
          tokenPriceUsd = price.toString();
        }
      }

      const quote: DexQuote = {
        token: tokenMeta,
        priceUsd: D(tokenPriceUsd).toString(),
        marketCapUsd: bestPair.marketCap ? D(bestPair.marketCap).toString() : undefined,
        fdvUsd: bestPair.fdv ? D(bestPair.fdv).toString() : undefined,
        liquidityUsd: bestPair.liquidity?.usd ? D(bestPair.liquidity.usd).toString() : undefined,
        volume24hUsd: bestPair.volume?.h24 ? D(bestPair.volume.h24).toString() : undefined,
        priceChange: {
          m5: bestPair.priceChange?.m5,
          h1: bestPair.priceChange?.h1,
          h6: bestPair.priceChange?.h6,
          h24: bestPair.priceChange?.h24,
        },
        retrievedAt: Date.now(),
        pairUpdatedAt: bestPair.pairCreatedAt ? Number(bestPair.pairCreatedAt) : undefined,
      };

      return quote;
    } catch (err) {
      console.error(`[DEX Screener] Error fetching quote for ${chain}:${tokenAddress}:`, err);
      return null;
    }
  }

  /**
   * Search pairs across all chains using DEX Screener search API
   */
  public async searchTokens(query: string): Promise<DexQuote[]> {
    try {
      const endpoint = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'DJN-Paper-Trader-Bot/1.0' },
      });
      clearTimeout(timeoutId);
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data.pairs)) return [];

      const results: DexQuote[] = [];
      for (const pair of data.pairs.slice(0, 8)) {
        if (!pair.priceUsd || parseFloat(pair.priceUsd) <= 0) continue;
        const pairChain = this.normalizeChain(pair.chainId || 'solana');
        results.push({
          token: {
            address: pair.baseToken?.address || '',
            chain: pairChain,
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || 'UNKNOWN',
            imageUrl: pair.info?.imageUrl,
            pairAddress: pair.pairAddress,
            dexId: pair.dexId || 'dex',
            pairCreatedAt: pair.pairCreatedAt ? Number(pair.pairCreatedAt) : undefined,
            url: pair.url,
          },
          priceUsd: D(pair.priceUsd).toString(),
          marketCapUsd: pair.marketCap ? D(pair.marketCap).toString() : undefined,
          fdvUsd: pair.fdv ? D(pair.fdv).toString() : undefined,
          liquidityUsd: pair.liquidity?.usd ? D(pair.liquidity.usd).toString() : undefined,
          volume24hUsd: pair.volume?.h24 ? D(pair.volume.h24).toString() : undefined,
          priceChange: {
            m5: pair.priceChange?.m5,
            h1: pair.priceChange?.h1,
            h6: pair.priceChange?.h6,
            h24: pair.priceChange?.h24,
          },
          retrievedAt: Date.now(),
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Helper to manually seed cache (useful for testing and deterministic mocking)
   */
  public seedQuote(chain: SupportedChain, tokenAddress: string, quote: DexQuote): void {
    const key = `${chain}:${tokenAddress}`;
    this.cache.set(key, { quote, cachedAt: Date.now() });
  }

  public clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}

export function getChainDisplayName(chain: string): string {
  const lower = (chain || '').toLowerCase();
  const map: Record<string, string> = {
    solana: 'Solana',
    ronin: 'Ronin',
    base: 'Base',
    ethereum: 'Ethereum',
    bsc: 'BNB Chain',
    arbitrum: 'Arbitrum',
    polygon: 'Polygon',
    avalanche: 'Avalanche',
    sui: 'Sui',
    ton: 'TON',
    optimism: 'Optimism',
    blast: 'Blast',
    pulsechain: 'PulseChain',
    fantom: 'Fantom',
    cronos: 'Cronos',
  };
  return map[lower] || (lower.charAt(0).toUpperCase() + lower.slice(1));
}

export const dexScreener = new DexScreenerAdapter();
