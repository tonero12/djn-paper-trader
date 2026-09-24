/**
 * @file server/services/trading.ts
 * Deterministic Paper Trading Service: Accounting, preview validation, executions, valuations and performance metrics
 */

import {
  AccountSession,
  DexQuote,
  PendingActionIntent,
  PerformanceStats,
  Position,
  PositionValuation,
  SupportedChain,
  TradeFill,
  UserSettings,
} from '../types.js';
import { IStorage, storage } from '../storage/firestore.js';
import { dexScreener } from '../dexscreener/adapter.js';
import { calculateReturnPercent, D, Decimal, safeDivide } from '../utils/decimal.js';
import { config } from '../config.js';

export interface BuyPreview {
  spendAmountUsd: string;
  quotedPriceUsd: string;
  executedPriceUsd: string;
  estimatedQuantity: string;
  feeUsd: string;
  slippagePercent: string;
  simulatedCosts: boolean;
  intentId: string;
  expiresAt: number;
}

export interface SellPreview {
  positionId: string;
  symbol: string;
  tokenName: string;
  sellFraction: string;
  quantityToSell: string;
  quotedPriceUsd: string;
  executedPriceUsd: string;
  grossProceedsUsd: string;
  feeUsd: string;
  netProceedsUsd: string;
  allocatedCostBasisUsd: string;
  estimatedRealisedPnlUsd: string;
  estimatedReturnPercent: string;
  slippagePercent: string;
  simulatedCosts: boolean;
  intentId: string;
  expiresAt: number;
}

export class PaperTradingService {
  private store: IStorage;

  constructor(store: IStorage = storage) {
    this.store = store;
  }

  /**
   * Generates a validated Buy Preview and persists an expiring Confirmation Intent
   */
  public async prepareBuyPreview(params: {
    telegramId: number;
    sessionId: string;
    tokenAddress: string;
    chain: SupportedChain;
    spendAmountUsd: string;
    userSettings: UserSettings;
    tradeNote?: string;
  }): Promise<{ preview: BuyPreview; quote: DexQuote }> {
    const spend = D(params.spendAmountUsd);
    if (spend.lte(0)) {
      throw new Error('Buy amount must be greater than $0.00');
    }

    const session = await this.store.getActiveSession(params.telegramId);
    if (!session || session.sessionId !== params.sessionId || session.status !== 'active') {
      throw new Error('No active trading session found. Please use /start to begin.');
    }

    const currentCash = D(session.cashBalance);
    if (currentCash.lt(spend)) {
      throw new Error(`Insufficient balance: You have $${currentCash.toFixed(2)} virtual USD, but tried to spend $${spend.toFixed(2)}.`);
    }

    const quote = await dexScreener.getTokenQuote(params.tokenAddress, params.chain);
    if (!quote || D(quote.priceUsd).lte(0)) {
      throw new Error('Unable to retrieve valid market price for this token. Fills are blocked.');
    }

    // Determine simulated execution price and fees
    let executedPrice = D(quote.priceUsd);
    let feeUsd = D(0);
    let slippageApplied = D(0);

    if (params.userSettings.simulatedCosts) {
      slippageApplied = D(params.userSettings.slippagePercent);
      // Adverse buy slippage: executed at higher price
      executedPrice = executedPrice.times(D(1).plus(slippageApplied.dividedBy(100)));
      // Buy fee deducted from spend
      feeUsd = spend.times(D(params.userSettings.buyFeePercent).dividedBy(100));
    }

    const netSpend = spend.minus(feeUsd);
    const estimatedQuantity = netSpend.dividedBy(executedPrice);

    if (estimatedQuantity.lte(0)) {
      throw new Error('Estimated quantity is zero or negative.');
    }

    const now = Date.now();
    const expiresAt = now + config.quoteExpiryMs;
    const intentId = `buy_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 6)}`;

    const intent: PendingActionIntent = {
      intentId,
      telegramId: params.telegramId,
      sessionId: params.sessionId,
      action: 'confirm_buy',
      createdAt: now,
      expiresAt,
      executed: false,
      data: {
        spendAmountUsd: spend.toString(),
        tokenAddress: params.tokenAddress,
        chain: params.chain,
        pairAddress: quote.token.pairAddress,
        expectedPriceUsd: quote.priceUsd,
      },
    };

    await this.store.saveIntent(intent);

    const preview: BuyPreview = {
      spendAmountUsd: spend.toString(),
      quotedPriceUsd: quote.priceUsd,
      executedPriceUsd: executedPrice.toString(),
      estimatedQuantity: estimatedQuantity.toString(),
      feeUsd: feeUsd.toString(),
      slippagePercent: slippageApplied.toString(),
      simulatedCosts: params.userSettings.simulatedCosts,
      intentId,
      expiresAt,
    };

    return { preview, quote };
  }

  /**
   * Confirms and executes a paper buy atomically with price verification
   */
  public async confirmBuy(params: {
    intentId: string;
    telegramId: number;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string; quote: DexQuote }> {
    const intent = await this.store.getIntent(params.intentId);
    if (!intent) {
      throw new Error('Order confirmation not found or expired.');
    }
    if (intent.executed) {
      throw new Error('This order has already been executed.');
    }
    if (Date.now() > intent.expiresAt) {
      throw new Error('Quote has expired. Please review a fresh quote before confirming.');
    }
    if (intent.telegramId !== params.telegramId) {
      throw new Error('Unauthorized: Order does not belong to your account.');
    }

    const user = await this.store.getUser(params.telegramId);
    if (!user) throw new Error('User not found.');

    const tokenAddress = intent.data.tokenAddress!;
    const chain = intent.data.chain!;
    const spendAmount = D(intent.data.spendAmountUsd!);
    const expectedPrice = D(intent.data.expectedPriceUsd!);

    // Re-fetch fresh quote to verify price stability
    const freshQuote = await dexScreener.getTokenQuote(tokenAddress, chain, intent.data.pairAddress);
    if (!freshQuote || D(freshQuote.priceUsd).lte(0)) {
      throw new Error('Market price is currently unavailable. Order was aborted to protect your funds.');
    }

    const freshPrice = D(freshQuote.priceUsd);
    // Check material price deviation
    const priceDiffPercent = freshPrice.minus(expectedPrice).abs().dividedBy(expectedPrice).times(100);
    if (priceDiffPercent.gt(config.materialPriceChangeThresholdPercent)) {
      throw new Error(
        `Market price moved by ${priceDiffPercent.toFixed(2)}% (from $${expectedPrice.toString()} to $${freshPrice.toString()}). Order cancelled for your protection. Please review a fresh quote.`
      );
    }

    // Determine executed price with settings
    let executedPrice = freshPrice;
    let feeUsd = D(0);
    let slippagePercent = D(0);

    if (user.settings.simulatedCosts) {
      slippagePercent = D(user.settings.slippagePercent);
      executedPrice = executedPrice.times(D(1).plus(slippagePercent.dividedBy(100)));
      feeUsd = spendAmount.times(D(user.settings.buyFeePercent).dividedBy(100));
    }

    const netSpend = spendAmount.minus(feeUsd);
    const quantityBought = netSpend.dividedBy(executedPrice);

    // Commit atomically in storage
    const result = await this.store.executeBuyTransaction({
      intentId: params.intentId,
      telegramId: params.telegramId,
      sessionId: intent.sessionId,
      chain,
      tokenAddress,
      pairAddress: freshQuote.token.pairAddress,
      dexId: freshQuote.token.dexId,
      symbol: freshQuote.token.symbol,
      tokenName: freshQuote.token.name,
      imageUrl: freshQuote.token.imageUrl,
      executedPriceUsd: executedPrice.toString(),
      quotedPriceUsd: freshPrice.toString(),
      totalDebitUsd: spendAmount.toString(),
      feeUsd: feeUsd.toString(),
      slippagePercent: slippagePercent.toString(),
      quantityBought: quantityBought.toString(),
      tradeNote: params.tradeNote,
    });

    return { ...result, quote: freshQuote };
  }

  /**
   * Generates a validated Sell Preview and persists an expiring Confirmation Intent
   */
  public async prepareSellPreview(params: {
    telegramId: number;
    positionId: string;
    sellFraction: string; // "0.25", "0.50", "1.00" or custom "0.10"
    userSettings: UserSettings;
    tradeNote?: string;
  }): Promise<{ preview: SellPreview; quote: DexQuote; position: Position }> {
    const fraction = D(params.sellFraction);
    if (fraction.lte(0) || fraction.gt(1)) {
      throw new Error('Sell percentage must be between 1% and 100%.');
    }

    const position = await this.store.getPosition(params.positionId);
    if (!position || position.status !== 'open') {
      throw new Error('Open position not found or already closed.');
    }
    if (position.telegramId !== params.telegramId) {
      throw new Error('Unauthorized: This position does not belong to your account.');
    }

    const remainingQty = D(position.remainingQuantity);
    if (remainingQty.lte(0)) {
      throw new Error('Position has no remaining balance to sell.');
    }

    const quote = await dexScreener.getTokenQuote(position.tokenAddress, position.chain, position.pairAddress);
    if (!quote || D(quote.priceUsd).lte(0)) {
      throw new Error('Unable to retrieve market quote. Sells are temporarily blocked until data returns.');
    }

    const isFullClosure = fraction.gte(0.999999);
    const qtyToSell = isFullClosure ? remainingQty : remainingQty.times(fraction);
    const preSaleCost = D(position.remainingCostBasis);
    const allocatedCost = isFullClosure ? preSaleCost : preSaleCost.times(fraction);

    let executedPrice = D(quote.priceUsd);
    let feeUsd = D(0);
    let slippagePercent = D(0);

    if (params.userSettings.simulatedCosts) {
      slippagePercent = D(params.userSettings.slippagePercent);
      // Adverse sell slippage: fills at lower price
      executedPrice = executedPrice.times(D(1).minus(slippagePercent.dividedBy(100)));
      const grossProceeds = qtyToSell.times(executedPrice);
      feeUsd = grossProceeds.times(D(params.userSettings.sellFeePercent).dividedBy(100));
    }

    const grossProceeds = qtyToSell.times(executedPrice);
    const netProceeds = grossProceeds.minus(feeUsd);
    const estimatedRealisedPnl = netProceeds.minus(allocatedCost);
    const estimatedReturnPercent = calculateReturnPercent(estimatedRealisedPnl, allocatedCost);

    const now = Date.now();
    const expiresAt = now + config.quoteExpiryMs;
    const intentId = `sell_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 6)}`;

    const intent: PendingActionIntent = {
      intentId,
      telegramId: params.telegramId,
      sessionId: position.sessionId,
      action: 'confirm_sell',
      createdAt: now,
      expiresAt,
      executed: false,
      data: {
        positionId: position.positionId,
        sellFraction: fraction.toString(),
        expectedPriceUsd: quote.priceUsd,
      },
    };

    await this.store.saveIntent(intent);

    const preview: SellPreview = {
      positionId: position.positionId,
      symbol: position.symbol,
      tokenName: position.tokenName,
      sellFraction: fraction.toString(),
      quantityToSell: qtyToSell.toString(),
      quotedPriceUsd: quote.priceUsd,
      executedPriceUsd: executedPrice.toString(),
      grossProceedsUsd: grossProceeds.toString(),
      feeUsd: feeUsd.toString(),
      netProceedsUsd: netProceeds.toString(),
      allocatedCostBasisUsd: allocatedCost.toString(),
      estimatedRealisedPnlUsd: estimatedRealisedPnl.toString(),
      estimatedReturnPercent: estimatedReturnPercent.toString(),
      slippagePercent: slippagePercent.toString(),
      simulatedCosts: params.userSettings.simulatedCosts,
      intentId,
      expiresAt,
    };

    return { preview, quote, position };
  }

  /**
   * Confirms and executes a paper sell atomically with price verification
   */
  public async confirmSell(params: {
    intentId: string;
    telegramId: number;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string; realisedPnlUsd: string; isFullClosure: boolean; quote: DexQuote }> {
    const intent = await this.store.getIntent(params.intentId);
    if (!intent) {
      throw new Error('Sell confirmation not found or expired.');
    }
    if (intent.executed) {
      throw new Error('This order has already been executed.');
    }
    if (Date.now() > intent.expiresAt) {
      throw new Error('Quote has expired. Please review a fresh preview before confirming.');
    }
    if (intent.telegramId !== params.telegramId) {
      throw new Error('Unauthorized: Order does not belong to your account.');
    }

    const position = await this.store.getPosition(intent.data.positionId!);
    if (!position || position.status !== 'open') {
      throw new Error('Position already closed or not found.');
    }

    const user = await this.store.getUser(params.telegramId);
    if (!user) throw new Error('User not found.');

    const expectedPrice = D(intent.data.expectedPriceUsd!);
    const freshQuote = await dexScreener.getTokenQuote(position.tokenAddress, position.chain, position.pairAddress);
    if (!freshQuote || D(freshQuote.priceUsd).lte(0)) {
      throw new Error('Market price unavailable. Sell cancelled to protect your portfolio.');
    }

    const freshPrice = D(freshQuote.priceUsd);
    const priceDiffPercent = freshPrice.minus(expectedPrice).abs().dividedBy(expectedPrice).times(100);
    if (priceDiffPercent.gt(config.materialPriceChangeThresholdPercent)) {
      throw new Error(
        `Market price moved by ${priceDiffPercent.toFixed(2)}% (from $${expectedPrice.toString()} to $${freshPrice.toString()}). Order cancelled. Please review a fresh preview.`
      );
    }

    let executedPrice = freshPrice;
    let feeUsd = D(0);
    let slippagePercent = D(0);

    const fraction = D(intent.data.sellFraction!);
    const remainingQty = D(position.remainingQuantity);
    const qtyToSell = fraction.gte(0.999999) ? remainingQty : remainingQty.times(fraction);

    if (user.settings.simulatedCosts) {
      slippagePercent = D(user.settings.slippagePercent);
      executedPrice = executedPrice.times(D(1).minus(slippagePercent.dividedBy(100)));
      const grossProceeds = qtyToSell.times(executedPrice);
      feeUsd = grossProceeds.times(D(user.settings.sellFeePercent).dividedBy(100));
    }

    const result = await this.store.executeSellTransaction({
      intentId: params.intentId,
      telegramId: params.telegramId,
      sessionId: intent.sessionId,
      positionId: position.positionId,
      sellFraction: fraction.toString(),
      executedPriceUsd: executedPrice.toString(),
      quotedPriceUsd: freshPrice.toString(),
      feeUsd: feeUsd.toString(),
      slippagePercent: slippagePercent.toString(),
      tradeNote: params.tradeNote,
    });

    return { ...result, quote: freshQuote };
  }

  /**
   * Values an open position against the latest live DEX Screener quote
   */
  public async valuePosition(position: Position, userSettings?: UserSettings): Promise<PositionValuation> {
    const remainingQty = D(position.remainingQuantity);
    const costBasis = D(position.remainingCostBasis);

    const quote = await dexScreener.getTokenQuote(position.tokenAddress, position.chain, position.pairAddress);
    
    let currentPriceUsd = '0';
    let isStale = false;
    let quoteRetrievedAt = Date.now();

    if (quote && D(quote.priceUsd).gt(0)) {
      currentPriceUsd = quote.priceUsd;
      quoteRetrievedAt = quote.retrievedAt;
    } else {
      // Preserve last known valuation if quote unavailable, flagged as stale
      isStale = true;
      currentPriceUsd = position.averageEntryPrice;
    }

    const currentPrice = D(currentPriceUsd);
    const markedMarketValue = remainingQty.times(currentPrice);

    // Estimated liquidation proceeds if simulated costs enabled
    let liquidationProceeds = markedMarketValue;
    if (userSettings && userSettings.simulatedCosts) {
      const slippage = D(userSettings.slippagePercent);
      const estPrice = currentPrice.times(D(1).minus(slippage.dividedBy(100)));
      const gross = remainingQty.times(estPrice);
      const fee = gross.times(D(userSettings.sellFeePercent).dividedBy(100));
      liquidationProceeds = gross.minus(fee);
    }

    const unrealisedPnl = markedMarketValue.minus(costBasis);
    const unrealisedPercent = calculateReturnPercent(unrealisedPnl, costBasis);

    return {
      position,
      currentPriceUsd,
      markedMarketValueUsd: markedMarketValue.toString(),
      estimatedLiquidationProceedsUsd: liquidationProceeds.toString(),
      unrealisedPnlUsd: unrealisedPnl.toString(),
      unrealisedPnlPercent: unrealisedPercent.toString(),
      realisedPnlUsd: position.totalRealisedPnl,
      quoteRetrievedAt,
      isStale,
    };
  }

  /**
   * Calculates overall practice performance statistics for the user's active session
   */
  public async getPerformanceStats(telegramId: number): Promise<PerformanceStats> {
    const user = await this.store.getUser(telegramId);
    if (!user) throw new Error('User account not found.');

    const session = await this.store.getActiveSession(telegramId);
    if (!session) throw new Error('Trading session not found.');

    const openPositions = await this.store.getOpenPositions(telegramId, session.sessionId);
    const allPositions = await this.store.getAllPositions(telegramId, session.sessionId);
    const closedPositions = allPositions.filter(p => p.status === 'closed');

    let openPositionsValue = D(0);
    let totalUnrealisedPnl = D(0);
    let totalRealisedPnl = D(0);
    let isEquityIncomplete = false;

    for (const pos of openPositions) {
      const valuation = await this.valuePosition(pos, user.settings);
      if (valuation.isStale) {
        isEquityIncomplete = true;
      }
      openPositionsValue = openPositionsValue.plus(D(valuation.markedMarketValueUsd));
      totalUnrealisedPnl = totalUnrealisedPnl.plus(D(valuation.unrealisedPnlUsd));
      totalRealisedPnl = totalRealisedPnl.plus(D(pos.totalRealisedPnl));
    }

    for (const pos of closedPositions) {
      totalRealisedPnl = totalRealisedPnl.plus(D(pos.totalRealisedPnl));
    }

    const cash = D(session.cashBalance);
    const totalEquity = cash.plus(openPositionsValue);

    // Win rate on completed positions:
    // Profit > 0 = winning; Profit < 0 = losing; Profit == 0 = break-even
    let winningCount = 0;
    let losingCount = 0;
    let breakEvenCount = 0;

    let bestTrade: { symbol: string; realisedPnlUsd: string; returnPercent: string } | undefined;
    let worstTrade: { symbol: string; realisedPnlUsd: string; returnPercent: string } | undefined;

    for (const pos of closedPositions) {
      const pnl = D(pos.totalRealisedPnl);
      const totalBuyCost = D(pos.totalCostBasisBought);
      const returnPct = calculateReturnPercent(pnl, totalBuyCost);

      if (pnl.gt(0)) {
        winningCount++;
      } else if (pnl.lt(0)) {
        losingCount++;
      } else {
        breakEvenCount++;
      }

      if (!bestTrade || pnl.gt(D(bestTrade.realisedPnlUsd))) {
        bestTrade = {
          symbol: pos.symbol,
          realisedPnlUsd: pnl.toString(),
          returnPercent: returnPct.toString(),
        };
      }

      if (!worstTrade || pnl.lt(D(worstTrade.realisedPnlUsd))) {
        worstTrade = {
          symbol: pos.symbol,
          realisedPnlUsd: pnl.toString(),
          returnPercent: returnPct.toString(),
        };
      }
    }

    const completedCount = closedPositions.length;
    // Win rate = winning / completed * 100
    const winRate = completedCount > 0
      ? D(winningCount).dividedBy(D(completedCount)).times(100)
      : D(0);

    return {
      startingBalance: session.startingBalance,
      cashBalance: session.cashBalance,
      openPositionsValueUsd: openPositionsValue.toString(),
      totalAccountEquityUsd: totalEquity.toString(),
      totalRealisedPnlUsd: totalRealisedPnl.toString(),
      totalUnrealisedPnlUsd: totalUnrealisedPnl.toString(),
      completedPositionsCount: completedCount,
      winningTradesCount: winningCount,
      losingTradesCount: losingCount,
      breakEvenTradesCount: breakEvenCount,
      winRatePercent: winRate.toString(),
      bestTrade,
      worstTrade,
      isEquityIncomplete,
    };
  }
}

export const paperTrading = new PaperTradingService();
