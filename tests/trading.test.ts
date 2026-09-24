/**
 * @file tests/trading.test.ts
 * Comprehensive deterministic paper trading accounting and test suite
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PaperTradingService } from '../server/services/trading.js';
import { createStorage, DEFAULT_USER_SETTINGS, IStorage } from '../server/storage/firestore.js';
import { dexScreener } from '../server/dexscreener/adapter.js';
import { D, formatPrice, formatQuantity, formatUsd } from '../server/utils/decimal.js';
import { cardRenderer } from '../server/services/cardRenderer.js';

describe('DJN Paper Trader - Accounting & Engine Test Suite', () => {
  let store: IStorage;
  let trading: PaperTradingService;
  const TEST_USER_ID = 123456789;
  const TOKEN_ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK Solana
  const CHAIN = 'solana';

  beforeEach(() => {
    dexScreener.clearCache();
    store = createStorage();
    trading = new PaperTradingService(store);
  });

  it('Initial balance credited only once: repeated /start never replenishes funds', async () => {
    // First creation
    const { session: firstSession, isNewUser: firstIsNew } = await store.getOrCreateUser(TEST_USER_ID, 'Alice');
    expect(firstIsNew).toBe(true);
    expect(firstSession.cashBalance).toBe('1000.00');
    expect(firstSession.startingBalance).toBe('1000.00');

    // Simulate debiting some funds
    const now = Date.now();
    await store.saveIntent({
      intentId: 'intent_init',
      telegramId: TEST_USER_ID,
      sessionId: firstSession.sessionId,
      action: 'confirm_buy',
      createdAt: now,
      expiresAt: now + 30000,
      executed: false,
      data: { spendAmountUsd: '200.00' },
    });

    await store.executeBuyTransaction({
      intentId: 'intent_init',
      telegramId: TEST_USER_ID,
      sessionId: firstSession.sessionId,
      chain: 'solana',
      tokenAddress: TOKEN_ADDR,
      pairAddress: 'pair_1',
      dexId: 'raydium',
      symbol: 'BONK',
      tokenName: 'Bonk',
      executedPriceUsd: '0.00001',
      quotedPriceUsd: '0.00001',
      totalDebitUsd: '200.00',
      feeUsd: '0',
      slippagePercent: '0',
      quantityBought: '20000000',
    });

    // Check balance is $800.00
    const activeSess = await store.getActiveSession(TEST_USER_ID);
    expect(activeSess?.cashBalance).toBe('800');

    // Repeated call to getOrCreateUser (e.g. user types /start again)
    const { session: repeatedSession, isNewUser: repeatedIsNew } = await store.getOrCreateUser(TEST_USER_ID, 'Alice');
    expect(repeatedIsNew).toBe(false);
    expect(repeatedSession.cashBalance).toBe('800'); // MUST NOT BE REPLENISHED!
  });

  it('Executes the exact Section 12 Zero-Cost Example flawlessly', async () => {
    /**
     * Start with $1,000.
     * Buy $100 at $0.01: receive 10,000 tokens; cash = $900.
     * Price reaches $0.015: position = $150; unrealised profit = $50.
     * Sell half: cash = $975; realised profit = $25; remaining cost basis = $50.
     * Sell the remainder at $0.008: final cash = $1,015; total realised profit = $15; position return = 15%.
     */
    const { session } = await store.getOrCreateUser(TEST_USER_ID, 'ZeroCostTrader');
    expect(session.cashBalance).toBe('1000.00');

    // 1. Seed price at $0.01
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'Memecoin', symbol: 'MEME', pairAddress: 'p1', dexId: 'raydium' },
      priceUsd: '0.01',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    // Buy $100
    const { preview: buyPrev } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '100',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    expect(D(buyPrev.estimatedQuantity).toNumber()).toBe(10000);

    const { fill: buyFill, position: pos1, newCashBalance: cash1 } = await trading.confirmBuy({
      intentId: buyPrev.intentId,
      telegramId: TEST_USER_ID,
    });

    expect(cash1).toBe('900');
    expect(D(pos1.remainingQuantity).toNumber()).toBe(10000);
    expect(D(pos1.remainingCostBasis).toNumber()).toBe(100);

    // 2. Price reaches $0.015: position marked value = $150; unrealised profit = $50
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'Memecoin', symbol: 'MEME', pairAddress: 'p1', dexId: 'raydium' },
      priceUsd: '0.015',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const valuation1 = await trading.valuePosition(pos1);
    expect(D(valuation1.markedMarketValueUsd).toNumber()).toBe(150);
    expect(D(valuation1.unrealisedPnlUsd).toNumber()).toBe(50);
    expect(D(valuation1.unrealisedPnlPercent).toNumber()).toBe(50); // +50%

    // 3. Sell half: cash = $975; realised profit = $25; remaining cost basis = $50
    const { preview: sellHalfPrev } = await trading.prepareSellPreview({
      telegramId: TEST_USER_ID,
      positionId: pos1.positionId,
      sellFraction: '0.50',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    expect(D(sellHalfPrev.quantityToSell).toNumber()).toBe(5000);
    expect(D(sellHalfPrev.netProceedsUsd).toNumber()).toBe(75);
    expect(D(sellHalfPrev.estimatedRealisedPnlUsd).toNumber()).toBe(25);

    const { fill: sellFill1, position: pos2, newCashBalance: cash2, realisedPnlUsd: pnl1 } = await trading.confirmSell({
      intentId: sellHalfPrev.intentId,
      telegramId: TEST_USER_ID,
    });

    expect(cash2).toBe('975');
    expect(D(pnl1).toNumber()).toBe(25);
    expect(D(pos2.remainingCostBasis).toNumber()).toBe(50);
    expect(D(pos2.remainingQuantity).toNumber()).toBe(5000);
    expect(pos2.status).toBe('open');

    // 4. Sell the remainder at $0.008: final cash = $1,015; total realised profit = $15; position return = 15%.
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'Memecoin', symbol: 'MEME', pairAddress: 'p1', dexId: 'raydium' },
      priceUsd: '0.008',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: sellRestPrev } = await trading.prepareSellPreview({
      telegramId: TEST_USER_ID,
      positionId: pos2.positionId,
      sellFraction: '1.00',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    expect(D(sellRestPrev.quantityToSell).toNumber()).toBe(5000);
    expect(D(sellRestPrev.netProceedsUsd).toNumber()).toBe(40); // 5000 * 0.008 = 40
    // Realised on this sale = 40 - 50 = -10
    expect(D(sellRestPrev.estimatedRealisedPnlUsd).toNumber()).toBe(-10);

    const { position: pos3, newCashBalance: cash3 } = await trading.confirmSell({
      intentId: sellRestPrev.intentId,
      telegramId: TEST_USER_ID,
    });

    expect(cash3).toBe('1015');
    expect(D(pos3.totalRealisedPnl).toNumber()).toBe(15); // $25 - $10 = $15 total realised profit
    expect(pos3.status).toBe('closed');
    expect(D(pos3.remainingQuantity).toNumber()).toBe(0);

    // Total return % on position: total realised P&L ($15) / total buy cost ($100) * 100 = 15%
    const totalReturnPct = D(pos3.totalRealisedPnl).dividedBy(D(pos3.totalCostBasisBought)).times(100);
    expect(totalReturnPct.toNumber()).toBe(15);
  });

  it('Handles buy and full sell at unchanged price (zero P&L)', async () => {
    const { session } = await store.getOrCreateUser(TEST_USER_ID);
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: bp } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '50',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    const { position } = await trading.confirmBuy({ intentId: bp.intentId, telegramId: TEST_USER_ID });
    expect(D(position.remainingQuantity).toNumber()).toBe(50);

    const { preview: sp } = await trading.prepareSellPreview({
      telegramId: TEST_USER_ID,
      positionId: position.positionId,
      sellFraction: '1.00',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    const { newCashBalance, realisedPnlUsd, isFullClosure } = await trading.confirmSell({
      intentId: sp.intentId,
      telegramId: TEST_USER_ID,
    });

    expect(newCashBalance).toBe('1000');
    expect(D(realisedPnlUsd).toNumber()).toBe(0);
    expect(isFullClosure).toBe(true);
  });

  it('Correctly calculates additional buys and weighted-average cost', async () => {
    const { session } = await store.getOrCreateUser(TEST_USER_ID);

    // Buy 1: 100 tokens at $1.00 = $100 spent
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: bp1 } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '100',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    const { position: p1 } = await trading.confirmBuy({ intentId: bp1.intentId, telegramId: TEST_USER_ID });
    expect(D(p1.averageEntryPrice).toNumber()).toBe(1.00);

    // Buy 2: Spend $300 at $3.00 = 100 tokens
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '3.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: bp2 } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '300',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    const { position: p2 } = await trading.confirmBuy({ intentId: bp2.intentId, telegramId: TEST_USER_ID });

    // Total cost basis = $100 + $300 = $400
    // Total quantity = 100 + 100 = 200 tokens
    // Weighted-average cost = $400 / 200 = $2.00
    expect(D(p2.remainingCostBasis).toNumber()).toBe(400);
    expect(D(p2.remainingQuantity).toNumber()).toBe(200);
    expect(D(p2.averageEntryPrice).toNumber()).toBe(2.00);
  });

  it('Applies simulated fees and adverse slippage in practice mode', async () => {
    const { session } = await store.getOrCreateUser(TEST_USER_ID);
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      simulatedCosts: true,
      buyFeePercent: 1.0, // 1%
      sellFeePercent: 1.0, // 1%
      slippagePercent: 2.0, // 2% adverse
    };

    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '10.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    // Buy $100:
    // Fee = $1.00 -> net spend = $99.00
    // Executed price = $10.00 * 1.02 = $10.20
    // Quantity = 99 / 10.20 = 9.70588235...
    const { preview: bp } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '100',
      userSettings: settings,
    });

    expect(bp.simulatedCosts).toBe(true);
    expect(D(bp.feeUsd).toNumber()).toBe(1.00);
    expect(D(bp.executedPriceUsd).toNumber()).toBe(10.20);

    const { position } = await trading.confirmBuy({ intentId: bp.intentId, telegramId: TEST_USER_ID });

    // Sell 100%:
    // Executed price with 2% adverse slippage = $10.00 * 0.98 = $9.80
    // Gross = quantity * 9.80
    // Fee = 1% of gross
    const { preview: sp } = await trading.prepareSellPreview({
      telegramId: TEST_USER_ID,
      positionId: position.positionId,
      sellFraction: '1.00',
      userSettings: settings,
    });

    expect(D(sp.executedPriceUsd).toNumber()).toBe(9.80);
    expect(D(sp.feeUsd).gt(0)).toBe(true);
  });

  it('Blocks insufficient balance and overselling', async () => {
    const { session } = await store.getOrCreateUser(TEST_USER_ID);

    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    // Attempt to spend $1,500 when balance is $1,000
    await expect(
      trading.prepareBuyPreview({
        telegramId: TEST_USER_ID,
        sessionId: session.sessionId,
        tokenAddress: TOKEN_ADDR,
        chain: CHAIN,
        spendAmountUsd: '1500',
        userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
      })
    ).rejects.toThrow(/Insufficient balance/i);

    // Buy $100 validly
    const { preview: bp } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '100',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    const { position } = await trading.confirmBuy({ intentId: bp.intentId, telegramId: TEST_USER_ID });

    // Sell fraction > 1.0 (oversell attempt)
    await expect(
      trading.prepareSellPreview({
        telegramId: TEST_USER_ID,
        positionId: position.positionId,
        sellFraction: '1.50',
        userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
      })
    ).rejects.toThrow(/between 1% and 100%/i);
  });

  it('Blocks double-clicked confirmations and duplicate updates', async () => {
    const { session } = await store.getOrCreateUser(TEST_USER_ID);
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '100',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    // First click: succeeds
    await trading.confirmBuy({ intentId: preview.intentId, telegramId: TEST_USER_ID });

    // Second click with same intentId: MUST REJECT
    await expect(
      trading.confirmBuy({ intentId: preview.intentId, telegramId: TEST_USER_ID })
    ).rejects.toThrow(/already been executed/i);
  });

  it('Enforces user isolation and denies unauthorized order execution', async () => {
    const userA = 11111;
    const userB = 22222;
    const { session: sessA } = await store.getOrCreateUser(userA);
    const { session: sessB } = await store.getOrCreateUser(userB);

    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: prevA } = await trading.prepareBuyPreview({
      telegramId: userA,
      sessionId: sessA.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '50',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    // User B attempts to confirm User A's order intent
    await expect(
      trading.confirmBuy({ intentId: prevA.intentId, telegramId: userB })
    ).rejects.toThrow(/Unauthorized/i);
  });

  it('Reset-session isolation: archives old session, preserves historical trades, starts fresh $1000', async () => {
    const { session: oldSession } = await store.getOrCreateUser(TEST_USER_ID);
    dexScreener.seedQuote(CHAIN, TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: CHAIN, name: 'T', symbol: 'T', pairAddress: 'p1', dexId: 'dex' },
      priceUsd: '1.00',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    // Buy $200
    const { preview: bp } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: oldSession.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: CHAIN,
      spendAmountUsd: '200',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    await trading.confirmBuy({ intentId: bp.intentId, telegramId: TEST_USER_ID });

    const activeBeforeReset = await store.getActiveSession(TEST_USER_ID);
    expect(activeBeforeReset?.cashBalance).toBe('800');

    // Reset account
    const { oldSession: archived, newSession } = await store.resetAccountSession(TEST_USER_ID);
    expect(archived.status).toBe('archived');
    expect(newSession.status).toBe('active');
    expect(newSession.cashBalance).toBe('1000.00');

    // Historical trade remains in database
    const history = await store.getTradeHistory(TEST_USER_ID);
    expect(history.length).toBe(1);

    // New active positions in new session is 0
    const openPos = await store.getOpenPositions(TEST_USER_ID, newSession.sessionId);
    expect(openPos.length).toBe(0);
  });

  it('Renders valid P&L Card with matching ledger snapshot numbers', async () => {
    const snapshot = {
      cardId: 'test_card_1',
      telegramId: TEST_USER_ID,
      sessionId: 'sess_1',
      positionId: 'pos_1',
      tokenName: 'Bonk Memecoin',
      tokenSymbol: 'BONK',
      chain: 'solana' as const,
      cardScope: 'open' as const,
      pnlUsd: '50.00',
      pnlPercent: '50.00',
      entryPriceUsd: '0.01',
      currentOrExitPriceUsd: '0.015',
      investedCostBasisUsd: '100.00',
      snapshotTimestamp: Date.now(),
      theme: 'pepe' as const,
    };

    const svg = await cardRenderer.generateSvg(snapshot);
    expect(svg).toContain('BONK');
    expect(svg).toContain('+50.00%');
    expect(svg).toContain('+$50.00');
    expect(svg).toContain('PAPER TRADE • SIMULATED FUNDS');
    expect(svg).toContain('DJN PAPER TRADER');

    // Render PNG Buffer via sharp
    const png = await cardRenderer.renderPng(snapshot);
    expect(png).toBeInstanceOf(Buffer);
    expect(png.length).toBeGreaterThan(1000);
  });

  it('Supports all chains across DEX Screener (Ronin/Robin, Arbitrum, Base, Solana, etc.)', async () => {
    // 1. Parsing Ronin prefixed format
    const parsedRonin = dexScreener.parseInput('ronin:0x078a0a163e775664cf853170714383fa34d0ddae');
    expect(parsedRonin).not.toBeNull();
    expect(parsedRonin?.chain).toBe('ronin');
    expect(parsedRonin?.address.toLowerCase()).toBe('0x078a0a163e775664cf853170714383fa34d0ddae');

    // 2. Parsing "robin" user alias (common spoken/typed variation)
    const parsedRobin = dexScreener.parseInput('robin 0x078a0a163e775664cf853170714383fa34d0ddae');
    expect(parsedRobin).not.toBeNull();
    expect(parsedRobin?.chain).toBe('ronin');

    // 3. Parsing DEX Screener URL for Ronin
    const parsedUrl = dexScreener.parseInput('https://dexscreener.com/ronin/0x078a0a163e775664cf853170714383fa34d0ddae');
    expect(parsedUrl).not.toBeNull();
    expect(parsedUrl?.chain).toBe('ronin');
    expect(parsedUrl?.isPairUrl).toBe(true);

    // 4. Parsing Arbitrum
    const parsedArb = dexScreener.parseInput('arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548');
    expect(parsedArb).not.toBeNull();
    expect(parsedArb?.chain).toBe('arbitrum');

    // 5. Seed quotes and execute paper trades on Ronin
    const RONIN_TOKEN = '0x078a0a163e775664cf853170714383fa34d0ddae';
    dexScreener.seedQuote('ronin', RONIN_TOKEN, {
      token: {
        address: RONIN_TOKEN,
        chain: 'ronin',
        name: 'Smooth Love Potion',
        symbol: 'SLP',
        pairAddress: '0xpair_ronin_1',
        dexId: 'katana',
      },
      priceUsd: '0.0050',
      priceChange: { h24: 12.5 },
      retrievedAt: Date.now(),
    });

    const { session } = await store.getOrCreateUser(TEST_USER_ID);
    const { preview: buyPrev } = await trading.prepareBuyPreview({
      telegramId: TEST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: RONIN_TOKEN,
      chain: 'ronin',
      spendAmountUsd: '100.00',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    const buyResult = await trading.confirmBuy({ intentId: buyPrev.intentId, telegramId: TEST_USER_ID });
    expect(buyResult.position.chain).toBe('ronin');
    expect(buyResult.position.symbol).toBe('SLP');
    expect(buyResult.position.remainingQuantity).toBe('20000'); // 100 / 0.005 = 20,000 SLP
    expect(D(buyResult.newCashBalance).toFixed(2)).toBe('900.00');

    // Sell 50% at 2x price ($0.01)
    dexScreener.seedQuote('ronin', RONIN_TOKEN, {
      token: {
        address: buyResult.position.tokenAddress,
        chain: 'ronin',
        name: buyResult.position.tokenName,
        symbol: buyResult.position.symbol,
        pairAddress: buyResult.position.pairAddress,
        dexId: buyResult.position.dexId,
      },
      priceUsd: '0.0100',
      priceChange: { h24: 100 },
      retrievedAt: Date.now(),
    });

    const { preview: sellPrev } = await trading.prepareSellPreview({
      telegramId: TEST_USER_ID,
      positionId: buyResult.position.positionId,
      sellFraction: '0.50',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });

    const sellResult = await trading.confirmSell({ intentId: sellPrev.intentId, telegramId: TEST_USER_ID });
    expect(D(sellResult.realisedPnlUsd).toFixed(2)).toBe('50.00'); // 10,000 tokens * 0.01 = $100 proceeds - $50 cost basis = +$50
    expect(D(sellResult.newCashBalance).toFixed(2)).toBe('1000.00'); // 900 + 100 = 1000
    expect(sellResult.position.remainingQuantity).toBe('10000');
  });

  it('Recovers active trading session and open positions across restarts via Telegram ID', async () => {
    const PERSIST_USER_ID = 99887766;
    // 1. Initial start
    const { session } = await store.getOrCreateUser(PERSIST_USER_ID, 'RestartTrader');
    expect(session.cashBalance).toBe('1000.00');

    // 2. Buy a position
    dexScreener.seedQuote('solana', TOKEN_ADDR, {
      token: { address: TOKEN_ADDR, chain: 'solana', name: 'Solana Meme', symbol: 'SMEME', pairAddress: 'p_sol', dexId: 'raydium' },
      priceUsd: '0.05',
      priceChange: {},
      retrievedAt: Date.now(),
    });

    const { preview: bp } = await trading.prepareBuyPreview({
      telegramId: PERSIST_USER_ID,
      sessionId: session.sessionId,
      tokenAddress: TOKEN_ADDR,
      chain: 'solana',
      spendAmountUsd: '300',
      userSettings: { ...DEFAULT_USER_SETTINGS, simulatedCosts: false },
    });
    const { position } = await trading.confirmBuy({ intentId: bp.intentId, telegramId: PERSIST_USER_ID });
    expect(position.remainingQuantity).toBe('6000'); // 300 / 0.05

    // 3. Query existing session via storage.getActiveSession(telegramId)
    const existingSession = await store.getActiveSession(PERSIST_USER_ID);
    expect(existingSession).not.toBeNull();
    expect(existingSession?.sessionId).toBe(session.sessionId);
    expect(existingSession?.cashBalance).toBe('700');

    // 4. Query open positions
    const openPositions = await store.getOpenPositions(PERSIST_USER_ID, existingSession!.sessionId);
    expect(openPositions.length).toBe(1);
    expect(openPositions[0].symbol).toBe('SMEME');
    expect(openPositions[0].remainingQuantity).toBe('6000');

    // 5. Subsequent /start execution resumes without resetting funds
    const resumed = await store.getOrCreateUser(PERSIST_USER_ID, 'RestartTrader');
    expect(resumed.isNewUser).toBe(false);
    expect(resumed.session.cashBalance).toBe('700');
    expect(resumed.session.sessionId).toBe(session.sessionId);
  });
});
