/**
 * @file server/types.ts
 * Core types for DJN Paper Trader
 */

export type SupportedChain =
  | 'solana'
  | 'ronin'
  | 'base'
  | 'ethereum'
  | 'bsc'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'sui'
  | 'ton'
  | 'blast'
  | 'optimism'
  | 'pulsechain'
  | 'fantom'
  | 'cronos'
  | string;

export type PositionStatus = 'open' | 'closed';

export type OrderSide = 'buy' | 'sell';

export interface UserSettings {
  defaultChain: SupportedChain;
  buyPresets: number[]; // e.g. [25, 50, 100]
  simulatedCosts: boolean; // true = apply fees & slippage, false = simple price tracking
  buyFeePercent: number; // e.g. 0.5%
  sellFeePercent: number; // e.g. 0.5%
  slippagePercent: number; // e.g. 1.0%
  cardTheme: 'pepe' | 'doge' | 'chad';
  showDisplayName: boolean;
  displayName?: string;
}

export interface UserAccount {
  telegramId: number;
  currentSessionId: string;
  createdAt: number;
  updatedAt: number;
  settings: UserSettings;
}

export interface AccountSession {
  sessionId: string;
  telegramId: number;
  startingBalance: string; // Decimal string e.g. "1000.00"
  cashBalance: string; // Available virtual USD cash
  status: 'active' | 'archived';
  createdAt: number;
  archivedAt?: number;
}

export interface TokenMetadata {
  address: string;
  chain: SupportedChain;
  name: string;
  symbol: string;
  imageUrl?: string;
  pairAddress: string;
  dexId: string;
  pairCreatedAt?: number; // timestamp in ms
  url?: string;
}

export interface DexQuote {
  token: TokenMetadata;
  priceUsd: string; // Decimal string
  marketCapUsd?: string;
  fdvUsd?: string;
  liquidityUsd?: string;
  volume24hUsd?: string;
  priceChange: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  retrievedAt: number; // timestamp when fetched
  pairUpdatedAt?: number;
}

export interface TradeFill {
  fillId: string;
  sessionId: string;
  telegramId: number;
  positionId: string;
  side: OrderSide;
  chain: SupportedChain;
  tokenAddress: string;
  pairAddress: string;
  symbol: string;
  tokenName: string;
  quotedPriceUsd: string;
  executedPriceUsd: string;
  quantity: string;
  cashDebitOrCredit: string; // positive amount of USD involved
  feeUsd: string;
  slippageAppliedPercent: string;
  timestamp: number;
  tradeNote?: string;
}

export interface Position {
  positionId: string;
  sessionId: string;
  telegramId: number;
  chain: SupportedChain;
  tokenAddress: string;
  pairAddress: string;
  dexId: string;
  symbol: string;
  tokenName: string;
  imageUrl?: string;
  status: PositionStatus;
  
  // Holdings & accounting
  totalQuantityBought: string;
  totalCostBasisBought: string; // Total USD debited for all buys in this position
  remainingQuantity: string;
  remainingCostBasis: string; // Unsold allocated cost basis
  averageEntryPrice: string; // remainingCostBasis / remainingQuantity
  
  // Realised results from partial or full sells
  totalQuantitySold: string;
  totalRealisedProceeds: string; // Net cash credited from sells
  totalRealisedPnl: string; // Realised profit in USD
  
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface PositionValuation {
  position: Position;
  currentPriceUsd: string;
  markedMarketValueUsd: string; // remainingQuantity * currentPriceUsd
  estimatedLiquidationProceedsUsd: string; // after sell fee/slippage if simulated costs enabled
  unrealisedPnlUsd: string; // markedMarketValueUsd - remainingCostBasis
  unrealisedPnlPercent: string; // unrealisedPnlUsd / remainingCostBasis * 100
  realisedPnlUsd: string; // from position.totalRealisedPnl
  quoteRetrievedAt: number;
  isStale: boolean;
}

export interface PendingActionIntent {
  intentId: string;
  telegramId: number;
  sessionId: string;
  action: 'confirm_buy' | 'confirm_sell' | 'confirm_reset';
  createdAt: number;
  expiresAt: number;
  executed: boolean;
  data: {
    // For buy:
    spendAmountUsd?: string;
    tokenAddress?: string;
    chain?: SupportedChain;
    pairAddress?: string;
    expectedPriceUsd?: string;
    
    // For sell:
    positionId?: string;
    sellFraction?: string; // "0.25", "0.50", "1.00", etc.
  };
}

export interface PerformanceStats {
  startingBalance: string;
  cashBalance: string;
  openPositionsValueUsd: string;
  totalAccountEquityUsd: string;
  totalRealisedPnlUsd: string;
  totalUnrealisedPnlUsd: string;
  completedPositionsCount: number;
  winningTradesCount: number;
  losingTradesCount: number;
  breakEvenTradesCount: number;
  winRatePercent: string; // winning / completed * 100 (break-evens excluded or counted as non-win, clearly labelled)
  bestTrade?: {
    symbol: string;
    realisedPnlUsd: string;
    returnPercent: string;
  };
  worstTrade?: {
    symbol: string;
    realisedPnlUsd: string;
    returnPercent: string;
  };
  isEquityIncomplete: boolean; // true if any open position's quote could not be retrieved
}

export interface PnlCardSnapshot {
  cardId: string;
  telegramId: number;
  sessionId: string;
  positionId: string;
  tokenName: string;
  tokenSymbol: string;
  chain: SupportedChain;
  cardScope: 'open' | 'partially_closed' | 'closed';
  pnlUsd: string;
  pnlPercent: string;
  entryPriceUsd: string;
  currentOrExitPriceUsd: string;
  investedCostBasisUsd: string;
  realisedPnlUsd?: string;
  unrealisedPnlUsd?: string;
  snapshotTimestamp: number;
  displayName?: string;
  theme: 'pepe' | 'doge' | 'chad';
  imageUrl?: string;
}
