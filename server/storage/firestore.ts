/**
 * @file server/storage/firestore.ts
 * Firestore persistence adapter with atomic transactions, session management, and test emulator fallback
 */

import { Firestore } from '@google-cloud/firestore';
import fs from 'fs';
import path from 'path';
import {
  AccountSession,
  PendingActionIntent,
  PnlCardSnapshot,
  Position,
  TradeFill,
  UserAccount,
  UserSettings,
} from '../types.js';
import { config } from '../config.js';
import { D } from '../utils/decimal.js';

export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultChain: 'solana',
  buyPresets: [25, 50, 100],
  simulatedCosts: false,
  buyFeePercent: 0.5,
  sellFeePercent: 0.5,
  slippagePercent: 1.0,
  cardTheme: 'pepe',
  showDisplayName: true,
};

export interface IStorage {
  isReady(): boolean;
  isRealFirestore(): boolean;
  getStorageType(): string;
  
  // Update deduplication
  isUpdateProcessed(updateId: number): Promise<boolean>;
  markUpdateProcessed(updateId: number): Promise<void>;

  // User & Session
  getOrCreateUser(telegramId: number, displayName?: string): Promise<{ user: UserAccount; session: AccountSession; isNewUser: boolean }>;
  getUser(telegramId: number): Promise<UserAccount | null>;
  updateUserSettings(telegramId: number, settings: Partial<UserSettings>): Promise<UserSettings>;
  getActiveSession(telegramId: number): Promise<AccountSession | null>;
  getSessionsForUser(telegramId: number): Promise<AccountSession[]>;
  resetAccountSession(telegramId: number): Promise<{ oldSession: AccountSession; newSession: AccountSession }>;

  // Positions
  getOpenPositions(telegramId: number, sessionId: string): Promise<Position[]>;
  getPosition(positionId: string): Promise<Position | null>;
  getOpenPositionForToken(telegramId: number, sessionId: string, chain: string, tokenAddress: string): Promise<Position | null>;
  getAllPositions(telegramId: number, sessionId?: string): Promise<Position[]>;

  // Fills & Trade History
  getTradeHistory(telegramId: number, sessionId?: string, limit?: number): Promise<TradeFill[]>;
  getFillsForPosition(positionId: string): Promise<TradeFill[]>;
  updateTradeNote(fillId: string, telegramId: number, note: string): Promise<boolean>;

  // Intents
  saveIntent(intent: PendingActionIntent): Promise<void>;
  getIntent(intentId: string): Promise<PendingActionIntent | null>;
  markIntentExecuted(intentId: string): Promise<boolean>;

  // Cards
  saveCardSnapshot(card: PnlCardSnapshot): Promise<void>;
  getCardSnapshot(cardId: string): Promise<PnlCardSnapshot | null>;

  // Atomic Trading Transactions
  executeBuyTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    chain: any;
    tokenAddress: string;
    pairAddress: string;
    dexId: string;
    symbol: string;
    tokenName: string;
    imageUrl?: string;
    executedPriceUsd: string;
    quotedPriceUsd: string;
    totalDebitUsd: string;
    feeUsd: string;
    slippagePercent: string;
    quantityBought: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string }>;

  executeSellTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    positionId: string;
    sellFraction: string; // e.g. "0.50" or "1.00"
    executedPriceUsd: string;
    quotedPriceUsd: string;
    feeUsd: string;
    slippagePercent: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string; realisedPnlUsd: string; isFullClosure: boolean }>;
}

/**
 * In-Memory Transactional Store (used for unit tests and local dev when Firestore credentials are absent)
 */
class InMemoryStorage implements IStorage {
  private users: Map<number, UserAccount> = new Map();
  private sessions: Map<string, AccountSession> = new Map();
  private positions: Map<string, Position> = new Map();
  private fills: Map<string, TradeFill> = new Map();
  private intents: Map<string, PendingActionIntent> = new Map();
  private cards: Map<string, PnlCardSnapshot> = new Map();
  private processedUpdates: Set<number> = new Set();
  private filePath: string | null = null;

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
      this.loadFromDisk();
    }
  }

  public isReady(): boolean {
    return true;
  }

  public isRealFirestore(): boolean {
    return false;
  }

  public getStorageType(): string {
    return this.filePath ? 'Persistent Local File Store' : 'In-Memory Transactional Store';
  }

  private loadFromDisk(): void {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.users)) this.users = new Map(parsed.users);
        if (Array.isArray(parsed.sessions)) this.sessions = new Map(parsed.sessions);
        if (Array.isArray(parsed.positions)) this.positions = new Map(parsed.positions);
        if (Array.isArray(parsed.fills)) this.fills = new Map(parsed.fills);
        if (Array.isArray(parsed.intents)) this.intents = new Map(parsed.intents);
        if (Array.isArray(parsed.cards)) this.cards = new Map(parsed.cards);
        if (Array.isArray(parsed.processedUpdates)) this.processedUpdates = new Set(parsed.processedUpdates);
        console.log(`[Storage] Loaded persistent state: ${this.users.size} users, ${this.positions.size} positions, ${this.fills.size} fills from ${this.filePath}`);
      }
    } catch (err) {
      console.error('[Storage] Error loading persistent store from disk:', err);
    }
  }

  public persistToDisk(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        savedAt: Date.now(),
        users: Array.from(this.users.entries()),
        sessions: Array.from(this.sessions.entries()),
        positions: Array.from(this.positions.entries()),
        fills: Array.from(this.fills.entries()),
        intents: Array.from(this.intents.entries()),
        cards: Array.from(this.cards.entries()),
        processedUpdates: Array.from(this.processedUpdates.values()).slice(-500),
      };
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[Storage] Error persisting store to disk:', err);
    }
  }

  public async isUpdateProcessed(updateId: number): Promise<boolean> {
    return this.processedUpdates.has(updateId);
  }

  public async markUpdateProcessed(updateId: number): Promise<void> {
    this.processedUpdates.add(updateId);
  }

  public async getOrCreateUser(telegramId: number, displayName?: string): Promise<{ user: UserAccount; session: AccountSession; isNewUser: boolean }> {
    let user = this.users.get(telegramId);
    const existingSession = await this.getActiveSession(telegramId);

    if (existingSession) {
      if (!user) {
        user = {
          telegramId,
          currentSessionId: existingSession.sessionId,
          createdAt: existingSession.createdAt,
          updatedAt: Date.now(),
          settings: {
            ...DEFAULT_USER_SETTINGS,
            displayName: displayName || undefined,
          },
        };
        this.users.set(telegramId, user);
        this.persistToDisk();
      } else if (user.currentSessionId !== existingSession.sessionId) {
        user.currentSessionId = existingSession.sessionId;
        user.updatedAt = Date.now();
        this.persistToDisk();
      }
      return { user, session: existingSession, isNewUser: false };
    }

    if (user) {
      const session = this.sessions.get(user.currentSessionId);
      if (session) {
        return { user, session, isNewUser: false };
      }
    }

    // Brand new user and session
    const now = Date.now();
    const sessionId = `sess_${telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const newSession: AccountSession = {
      sessionId,
      telegramId,
      startingBalance: '1000.00',
      cashBalance: '1000.00',
      status: 'active',
      createdAt: now,
    };

    const newUser: UserAccount = {
      telegramId,
      currentSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
      settings: {
        ...DEFAULT_USER_SETTINGS,
        displayName: displayName || undefined,
      },
    };

    this.users.set(telegramId, newUser);
    this.sessions.set(sessionId, newSession);
    this.persistToDisk();
    return { user: newUser, session: newSession, isNewUser: true };
  }

  public async getUser(telegramId: number): Promise<UserAccount | null> {
    return this.users.get(telegramId) || null;
  }

  public async updateUserSettings(telegramId: number, settings: Partial<UserSettings>): Promise<UserSettings> {
    const user = this.users.get(telegramId);
    if (!user) throw new Error('User not found');
    user.settings = { ...user.settings, ...settings };
    user.updatedAt = Date.now();
    this.persistToDisk();
    return user.settings;
  }

  public async getActiveSession(telegramId: number): Promise<AccountSession | null> {
    const user = this.users.get(telegramId);
    if (user) {
      const sess = this.sessions.get(user.currentSessionId);
      if (sess && sess.status === 'active') return sess;
    }

    // Direct query over persistent sessions for this telegramId
    const activeSessions: AccountSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.telegramId === telegramId && s.status === 'active') {
        activeSessions.push(s);
      }
    }
    if (activeSessions.length > 0) {
      activeSessions.sort((a, b) => b.createdAt - a.createdAt);
      const active = activeSessions[0];
      if (user && user.currentSessionId !== active.sessionId) {
        user.currentSessionId = active.sessionId;
        user.updatedAt = Date.now();
        this.persistToDisk();
      }
      return active;
    }
    return null;
  }

  public async getSessionsForUser(telegramId: number): Promise<AccountSession[]> {
    const results: AccountSession[] = [];
    for (const sess of this.sessions.values()) {
      if (sess.telegramId === telegramId) {
        results.push(sess);
      }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async resetAccountSession(telegramId: number): Promise<{ oldSession: AccountSession; newSession: AccountSession }> {
    const user = this.users.get(telegramId);
    if (!user) throw new Error('User not found');
    const oldSession = this.sessions.get(user.currentSessionId);
    if (!oldSession) throw new Error('Active session not found');

    const now = Date.now();
    oldSession.status = 'archived';
    oldSession.archivedAt = now;

    // Invalidate pending intents for this session
    for (const intent of this.intents.values()) {
      if (intent.sessionId === oldSession.sessionId) {
        intent.executed = true; // cancel
      }
    }

    // Create fresh session with exactly $1,000.00
    const newSessionId = `sess_${telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const newSession: AccountSession = {
      sessionId: newSessionId,
      telegramId,
      startingBalance: '1000.00',
      cashBalance: '1000.00',
      status: 'active',
      createdAt: now,
    };

    this.sessions.set(newSessionId, newSession);
    user.currentSessionId = newSessionId;
    user.updatedAt = now;
    this.persistToDisk();

    return { oldSession, newSession };
  }

  public async getOpenPositions(telegramId: number, sessionId: string): Promise<Position[]> {
    const results: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.telegramId === telegramId && pos.sessionId === sessionId && pos.status === 'open') {
        results.push(pos);
      }
    }
    return results;
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    return this.positions.get(positionId) || null;
  }

  public async getOpenPositionForToken(telegramId: number, sessionId: string, chain: string, tokenAddress: string): Promise<Position | null> {
    for (const pos of this.positions.values()) {
      const matchAddr = chain === 'solana'
        ? pos.tokenAddress === tokenAddress
        : pos.tokenAddress.toLowerCase() === tokenAddress.toLowerCase();
      if (pos.telegramId === telegramId && pos.sessionId === sessionId && pos.chain === chain && matchAddr && pos.status === 'open') {
        return pos;
      }
    }
    return null;
  }

  public async getAllPositions(telegramId: number, sessionId?: string): Promise<Position[]> {
    const results: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.telegramId === telegramId && (!sessionId || pos.sessionId === sessionId)) {
        results.push(pos);
      }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async getTradeHistory(telegramId: number, sessionId?: string, limit: number = 50): Promise<TradeFill[]> {
    const results: TradeFill[] = [];
    for (const fill of this.fills.values()) {
      if (fill.telegramId === telegramId && (!sessionId || fill.sessionId === sessionId)) {
        results.push(fill);
      }
    }
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results.slice(0, limit);
  }

  public async getFillsForPosition(positionId: string): Promise<TradeFill[]> {
    const results: TradeFill[] = [];
    for (const fill of this.fills.values()) {
      if (fill.positionId === positionId) {
        results.push(fill);
      }
    }
    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  public async updateTradeNote(fillId: string, telegramId: number, note: string): Promise<boolean> {
    const fill = this.fills.get(fillId);
    if (!fill || fill.telegramId !== telegramId) return false;
    fill.tradeNote = note;
    this.persistToDisk();
    return true;
  }

  public async saveIntent(intent: PendingActionIntent): Promise<void> {
    this.intents.set(intent.intentId, { ...intent });
    this.persistToDisk();
  }

  public async getIntent(intentId: string): Promise<PendingActionIntent | null> {
    return this.intents.get(intentId) || null;
  }

  public async markIntentExecuted(intentId: string): Promise<boolean> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.executed) return false;
    intent.executed = true;
    this.persistToDisk();
    return true;
  }

  public async saveCardSnapshot(card: PnlCardSnapshot): Promise<void> {
    this.cards.set(card.cardId, { ...card });
    this.persistToDisk();
  }

  public async getCardSnapshot(cardId: string): Promise<PnlCardSnapshot | null> {
    return this.cards.get(cardId) || null;
  }

  public async executeBuyTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    chain: any;
    tokenAddress: string;
    pairAddress: string;
    dexId: string;
    symbol: string;
    tokenName: string;
    imageUrl?: string;
    executedPriceUsd: string;
    quotedPriceUsd: string;
    totalDebitUsd: string;
    feeUsd: string;
    slippagePercent: string;
    quantityBought: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string }> {
    // 1. Validate intent idempotency
    const intent = this.intents.get(params.intentId);
    if (!intent || intent.executed) {
      throw new Error('Action confirmation already executed or invalid.');
    }
    if (intent.expiresAt < Date.now()) {
      throw new Error('Action confirmation expired. Please request a fresh quote.');
    }
    if (intent.telegramId !== params.telegramId || intent.sessionId !== params.sessionId) {
      throw new Error('Unauthorized session for this order.');
    }

    // 2. Validate session & cash balance
    const session = this.sessions.get(params.sessionId);
    if (!session || session.status !== 'active') {
      throw new Error('Active trading session not found.');
    }

    const currentCash = D(session.cashBalance);
    const debit = D(params.totalDebitUsd);
    if (currentCash.lt(debit)) {
      throw new Error(`Insufficient funds: available cash is $${currentCash.toFixed(2)}, required $${debit.toFixed(2)}`);
    }

    // 3. Mark intent executed immediately
    intent.executed = true;

    // 4. Debit cash
    const newCash = currentCash.minus(debit);
    session.cashBalance = newCash.toString();

    // 5. Look for existing open position for this token on this chain
    let position = await this.getOpenPositionForToken(params.telegramId, params.sessionId, params.chain, params.tokenAddress);
    const now = Date.now();
    const fillId = `fill_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;

    if (!position) {
      // Create new position
      const positionId = `pos_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
      position = {
        positionId,
        sessionId: params.sessionId,
        telegramId: params.telegramId,
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        pairAddress: params.pairAddress,
        dexId: params.dexId,
        symbol: params.symbol,
        tokenName: params.tokenName,
        imageUrl: params.imageUrl,
        status: 'open',
        totalQuantityBought: params.quantityBought,
        totalCostBasisBought: params.totalDebitUsd,
        remainingQuantity: params.quantityBought,
        remainingCostBasis: params.totalDebitUsd,
        averageEntryPrice: D(params.totalDebitUsd).dividedBy(D(params.quantityBought)).toString(),
        totalQuantitySold: '0',
        totalRealisedProceeds: '0',
        totalRealisedPnl: '0',
        createdAt: now,
        updatedAt: now,
      };
      this.positions.set(positionId, position);
    } else {
      // Weighted-average cost update on additional buy
      const oldQty = D(position.remainingQuantity);
      const addQty = D(params.quantityBought);
      const newRemainingQty = oldQty.plus(addQty);

      const oldCost = D(position.remainingCostBasis);
      const addCost = D(params.totalDebitUsd);
      const newRemainingCost = oldCost.plus(addCost);

      const newAvgEntry = newRemainingCost.dividedBy(newRemainingQty);

      position.totalQuantityBought = D(position.totalQuantityBought).plus(addQty).toString();
      position.totalCostBasisBought = D(position.totalCostBasisBought).plus(addCost).toString();
      position.remainingQuantity = newRemainingQty.toString();
      position.remainingCostBasis = newRemainingCost.toString();
      position.averageEntryPrice = newAvgEntry.toString();
      position.updatedAt = now;
      if (params.imageUrl && !position.imageUrl) {
        position.imageUrl = params.imageUrl;
      }
    }

    // 6. Record trade fill
    const fill: TradeFill = {
      fillId,
      sessionId: params.sessionId,
      telegramId: params.telegramId,
      positionId: position.positionId,
      side: 'buy',
      chain: params.chain,
      tokenAddress: params.tokenAddress,
      pairAddress: params.pairAddress,
      symbol: params.symbol,
      tokenName: params.tokenName,
      quotedPriceUsd: params.quotedPriceUsd,
      executedPriceUsd: params.executedPriceUsd,
      quantity: params.quantityBought,
      cashDebitOrCredit: params.totalDebitUsd,
      feeUsd: params.feeUsd,
      slippageAppliedPercent: params.slippagePercent,
      timestamp: now,
      tradeNote: params.tradeNote,
    };
    this.fills.set(fillId, fill);
    this.persistToDisk();

    return { fill, position, newCashBalance: newCash.toString() };
  }

  public async executeSellTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    positionId: string;
    sellFraction: string; // e.g. "0.25", "0.50", "1.00"
    executedPriceUsd: string;
    quotedPriceUsd: string;
    feeUsd: string;
    slippagePercent: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string; realisedPnlUsd: string; isFullClosure: boolean }> {
    // 1. Validate intent idempotency
    const intent = this.intents.get(params.intentId);
    if (!intent || intent.executed) {
      throw new Error('Action confirmation already executed or invalid.');
    }
    if (intent.expiresAt < Date.now()) {
      throw new Error('Action confirmation expired. Please request a fresh quote.');
    }
    if (intent.telegramId !== params.telegramId || intent.sessionId !== params.sessionId) {
      throw new Error('Unauthorized session for this order.');
    }

    // 2. Validate session & position
    const session = this.sessions.get(params.sessionId);
    if (!session || session.status !== 'active') {
      throw new Error('Active trading session not found.');
    }

    const position = this.positions.get(params.positionId);
    if (!position || position.status !== 'open' || position.sessionId !== params.sessionId) {
      throw new Error('Open position not found or already closed.');
    }

    const remainingQty = D(position.remainingQuantity);
    if (remainingQty.lte(0)) {
      throw new Error('Position has zero remaining balance.');
    }

    const fraction = D(params.sellFraction);
    if (fraction.lte(0) || fraction.gt(1)) {
      throw new Error('Invalid sell fraction.');
    }

    const isFullClosure = fraction.gte(0.999999);

    // Quantity to sell: exact remaining for 100% to prevent rounding dust!
    const qtyToSell = isFullClosure ? remainingQty : remainingQty.times(fraction);

    // Allocated cost basis: pre-sale remaining cost basis * fraction sold
    const preSaleRemainingCost = D(position.remainingCostBasis);
    const allocatedSaleCost = isFullClosure ? preSaleRemainingCost : preSaleRemainingCost.times(fraction);

    // Net sale proceeds = sold quantity * simulated sell execution price - sell fee
    const grossProceeds = qtyToSell.times(D(params.executedPriceUsd));
    const fee = D(params.feeUsd);
    const netProceeds = grossProceeds.minus(fee);

    // Realised P&L = net sale proceeds - allocated sale cost
    const realisedPnl = netProceeds.minus(allocatedSaleCost);

    // 3. Mark intent executed
    intent.executed = true;

    // 4. Update Cash
    const newCash = D(session.cashBalance).plus(netProceeds);
    session.cashBalance = newCash.toString();

    // 5. Update Position
    const now = Date.now();
    const newRemainingQty = isFullClosure ? D(0) : remainingQty.minus(qtyToSell);
    const newRemainingCost = isFullClosure ? D(0) : preSaleRemainingCost.minus(allocatedSaleCost);

    position.remainingQuantity = newRemainingQty.toString();
    position.remainingCostBasis = newRemainingCost.toString();
    position.totalQuantitySold = D(position.totalQuantitySold).plus(qtyToSell).toString();
    position.totalRealisedProceeds = D(position.totalRealisedProceeds).plus(netProceeds).toString();
    position.totalRealisedPnl = D(position.totalRealisedPnl).plus(realisedPnl).toString();
    position.updatedAt = now;

    if (isFullClosure) {
      position.status = 'closed';
      position.closedAt = now;
    }

    // 6. Record Fill
    const fillId = `fill_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const fill: TradeFill = {
      fillId,
      sessionId: params.sessionId,
      telegramId: params.telegramId,
      positionId: position.positionId,
      side: 'sell',
      chain: position.chain,
      tokenAddress: position.tokenAddress,
      pairAddress: position.pairAddress,
      symbol: position.symbol,
      tokenName: position.tokenName,
      quotedPriceUsd: params.quotedPriceUsd,
      executedPriceUsd: params.executedPriceUsd,
      quantity: qtyToSell.toString(),
      cashDebitOrCredit: netProceeds.toString(),
      feeUsd: params.feeUsd,
      slippageAppliedPercent: params.slippagePercent,
      timestamp: now,
      tradeNote: params.tradeNote,
    };
    this.fills.set(fillId, fill);
    this.persistToDisk();

    return {
      fill,
      position,
      newCashBalance: newCash.toString(),
      realisedPnlUsd: realisedPnl.toString(),
      isFullClosure,
    };
  }
}

/**
 * Real Google Cloud Firestore Storage Implementation
 */
class GoogleCloudFirestoreStorage implements IStorage {
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  public isReady(): boolean {
    return true;
  }

  public isRealFirestore(): boolean {
    return true;
  }

  public getStorageType(): string {
    return 'Google Cloud Firestore';
  }

  public async isUpdateProcessed(updateId: number): Promise<boolean> {
    const doc = await this.db.collection('processed_updates').doc(updateId.toString()).get();
    return doc.exists;
  }

  public async markUpdateProcessed(updateId: number): Promise<void> {
    await this.db.collection('processed_updates').doc(updateId.toString()).set({
      updateId,
      processedAt: Date.now(),
    });
  }

  public async getOrCreateUser(telegramId: number, displayName?: string): Promise<{ user: UserAccount; session: AccountSession; isNewUser: boolean }> {
    const userRef = this.db.collection('users').doc(telegramId.toString());
    const userSnap = await userRef.get();

    // 1. Query Firestore for any existing active session for this Telegram ID
    const existingActiveSession = await this.getActiveSession(telegramId);

    if (existingActiveSession) {
      if (userSnap.exists) {
        const user = userSnap.data() as UserAccount;
        if (user.currentSessionId !== existingActiveSession.sessionId) {
          await userRef.update({
            currentSessionId: existingActiveSession.sessionId,
            updatedAt: Date.now(),
          });
          user.currentSessionId = existingActiveSession.sessionId;
        }
        return { user, session: existingActiveSession, isNewUser: false };
      } else {
        // Recreate user document linking to the active session
        const newUser: UserAccount = {
          telegramId,
          currentSessionId: existingActiveSession.sessionId,
          createdAt: existingActiveSession.createdAt,
          updatedAt: Date.now(),
          settings: {
            ...DEFAULT_USER_SETTINGS,
            displayName: displayName || undefined,
          },
        };
        await userRef.set(newUser);
        return { user: newUser, session: existingActiveSession, isNewUser: false };
      }
    }

    if (userSnap.exists) {
      const user = userSnap.data() as UserAccount;
      const sessionSnap = await this.db.collection('sessions').doc(user.currentSessionId).get();
      if (sessionSnap.exists) {
        const session = sessionSnap.data() as AccountSession;
        return { user, session, isNewUser: false };
      }
    }

    // 2. Brand new user with fresh practice funds
    const now = Date.now();
    const sessionId = `sess_${telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const newSession: AccountSession = {
      sessionId,
      telegramId,
      startingBalance: '1000.00',
      cashBalance: '1000.00',
      status: 'active',
      createdAt: now,
    };

    const newUser: UserAccount = {
      telegramId,
      currentSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
      settings: {
        ...DEFAULT_USER_SETTINGS,
        displayName: displayName || undefined,
      },
    };

    const batch = this.db.batch();
    batch.set(userRef, newUser);
    batch.set(this.db.collection('sessions').doc(sessionId), newSession);
    await batch.commit();

    return { user: newUser, session: newSession, isNewUser: true };
  }

  public async getUser(telegramId: number): Promise<UserAccount | null> {
    const snap = await this.db.collection('users').doc(telegramId.toString()).get();
    return snap.exists ? (snap.data() as UserAccount) : null;
  }

  public async updateUserSettings(telegramId: number, settings: Partial<UserSettings>): Promise<UserSettings> {
    const userRef = this.db.collection('users').doc(telegramId.toString());
    const snap = await userRef.get();
    if (!snap.exists) throw new Error('User not found');
    const user = snap.data() as UserAccount;
    const newSettings = { ...user.settings, ...settings };
    await userRef.update({ settings: newSettings, updatedAt: Date.now() });
    return newSettings;
  }

  public async getActiveSession(telegramId: number): Promise<AccountSession | null> {
    // 1. Direct query in Firestore for any active sessions associated with user's Telegram ID
    try {
      const qSnap = await this.db.collection('sessions')
        .where('telegramId', '==', telegramId)
        .where('status', '==', 'active')
        .get();

      if (!qSnap.empty) {
        const sessions = qSnap.docs.map((d) => d.data() as AccountSession);
        sessions.sort((a, b) => b.createdAt - a.createdAt);
        return sessions[0];
      }
    } catch (err) {
      console.error('[Storage] Error querying active sessions by telegramId in Firestore:', err);
    }

    // 2. Fallback to user.currentSessionId document lookup if query failed
    const user = await this.getUser(telegramId);
    if (!user) return null;
    const snap = await this.db.collection('sessions').doc(user.currentSessionId).get();
    if (snap.exists) {
      const s = snap.data() as AccountSession;
      if (s.status === 'active') return s;
    }
    return null;
  }

  public async getSessionsForUser(telegramId: number): Promise<AccountSession[]> {
    try {
      const qSnap = await this.db.collection('sessions')
        .where('telegramId', '==', telegramId)
        .get();
      const sessions = qSnap.docs.map((d) => d.data() as AccountSession);
      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.error('[Storage] Error querying sessions for user in Firestore:', err);
      return [];
    }
  }

  public async resetAccountSession(telegramId: number): Promise<{ oldSession: AccountSession; newSession: AccountSession }> {
    return this.db.runTransaction(async (t) => {
      const userRef = this.db.collection('users').doc(telegramId.toString());
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');
      const user = userSnap.data() as UserAccount;

      const oldSessionRef = this.db.collection('sessions').doc(user.currentSessionId);
      const oldSessionSnap = await t.get(oldSessionRef);
      if (!oldSessionSnap.exists) throw new Error('Active session not found');
      const oldSession = oldSessionSnap.data() as AccountSession;

      const now = Date.now();
      const newSessionId = `sess_${telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const newSession: AccountSession = {
        sessionId: newSessionId,
        telegramId,
        startingBalance: '1000.00',
        cashBalance: '1000.00',
        status: 'active',
        createdAt: now,
      };

      t.update(oldSessionRef, { status: 'archived', archivedAt: now });
      t.set(this.db.collection('sessions').doc(newSessionId), newSession);
      t.update(userRef, { currentSessionId: newSessionId, updatedAt: now });

      return { oldSession: { ...oldSession, status: 'archived', archivedAt: now }, newSession };
    });
  }

  public async getOpenPositions(telegramId: number, sessionId: string): Promise<Position[]> {
    const query = await this.db.collection('positions')
      .where('telegramId', '==', telegramId)
      .where('sessionId', '==', sessionId)
      .where('status', '==', 'open')
      .get();

    return query.docs.map(d => d.data() as Position);
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    const snap = await this.db.collection('positions').doc(positionId).get();
    return snap.exists ? (snap.data() as Position) : null;
  }

  public async getOpenPositionForToken(telegramId: number, sessionId: string, chain: string, tokenAddress: string): Promise<Position | null> {
    const openPositions = await this.getOpenPositions(telegramId, sessionId);
    return openPositions.find(p => {
      const matchAddr = chain === 'solana'
        ? p.tokenAddress === tokenAddress
        : p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase();
      return p.chain === chain && matchAddr;
    }) || null;
  }

  public async getAllPositions(telegramId: number, sessionId?: string): Promise<Position[]> {
    let query = this.db.collection('positions').where('telegramId', '==', telegramId);
    if (sessionId) {
      query = query.where('sessionId', '==', sessionId);
    }
    const snap = await query.get();
    const pos = snap.docs.map(d => d.data() as Position);
    return pos.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async getTradeHistory(telegramId: number, sessionId?: string, limit: number = 50): Promise<TradeFill[]> {
    let query = this.db.collection('fills').where('telegramId', '==', telegramId);
    if (sessionId) {
      query = query.where('sessionId', '==', sessionId);
    }
    const snap = await query.limit(limit).get();
    const fills = snap.docs.map(d => d.data() as TradeFill);
    return fills.sort((a, b) => b.timestamp - a.timestamp);
  }

  public async getFillsForPosition(positionId: string): Promise<TradeFill[]> {
    const snap = await this.db.collection('fills').where('positionId', '==', positionId).get();
    const fills = snap.docs.map(d => d.data() as TradeFill);
    return fills.sort((a, b) => a.timestamp - b.timestamp);
  }

  public async updateTradeNote(fillId: string, telegramId: number, note: string): Promise<boolean> {
    const fillRef = this.db.collection('fills').doc(fillId);
    const snap = await fillRef.get();
    if (!snap.exists) return false;
    const fill = snap.data() as TradeFill;
    if (fill.telegramId !== telegramId) return false;
    await fillRef.update({ tradeNote: note });
    return true;
  }

  public async saveIntent(intent: PendingActionIntent): Promise<void> {
    await this.db.collection('intents').doc(intent.intentId).set(intent);
  }

  public async getIntent(intentId: string): Promise<PendingActionIntent | null> {
    const snap = await this.db.collection('intents').doc(intentId).get();
    return snap.exists ? (snap.data() as PendingActionIntent) : null;
  }

  public async markIntentExecuted(intentId: string): Promise<boolean> {
    const intentRef = this.db.collection('intents').doc(intentId);
    return this.db.runTransaction(async (t) => {
      const snap = await t.get(intentRef);
      if (!snap.exists) return false;
      const intent = snap.data() as PendingActionIntent;
      if (intent.executed) return false;
      t.update(intentRef, { executed: true });
      return true;
    });
  }

  public async saveCardSnapshot(card: PnlCardSnapshot): Promise<void> {
    await this.db.collection('cards').doc(card.cardId).set(card);
  }

  public async getCardSnapshot(cardId: string): Promise<PnlCardSnapshot | null> {
    const snap = await this.db.collection('cards').doc(cardId).get();
    return snap.exists ? (snap.data() as PnlCardSnapshot) : null;
  }

  public async executeBuyTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    chain: any;
    tokenAddress: string;
    pairAddress: string;
    dexId: string;
    symbol: string;
    tokenName: string;
    imageUrl?: string;
    executedPriceUsd: string;
    quotedPriceUsd: string;
    totalDebitUsd: string;
    feeUsd: string;
    slippagePercent: string;
    quantityBought: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string }> {
    return this.db.runTransaction(async (t) => {
      // 1. Verify intent
      const intentRef = this.db.collection('intents').doc(params.intentId);
      const intentSnap = await t.get(intentRef);
      if (!intentSnap.exists) throw new Error('Confirmation intent not found.');
      const intent = intentSnap.data() as PendingActionIntent;
      if (intent.executed) throw new Error('Confirmation already executed.');
      if (intent.expiresAt < Date.now()) throw new Error('Confirmation expired.');
      if (intent.telegramId !== params.telegramId || intent.sessionId !== params.sessionId) {
        throw new Error('Unauthorized session for this order.');
      }

      // 2. Verify session cash
      const sessionRef = this.db.collection('sessions').doc(params.sessionId);
      const sessionSnap = await t.get(sessionRef);
      if (!sessionSnap.exists) throw new Error('Session not found.');
      const session = sessionSnap.data() as AccountSession;
      if (session.status !== 'active') throw new Error('Session is archived.');

      const currentCash = D(session.cashBalance);
      const debit = D(params.totalDebitUsd);
      if (currentCash.lt(debit)) {
        throw new Error(`Insufficient funds: available cash is $${currentCash.toFixed(2)}, required $${debit.toFixed(2)}`);
      }

      // 3. Mark intent executed
      t.update(intentRef, { executed: true });

      // 4. Debit cash
      const newCash = currentCash.minus(debit);
      t.update(sessionRef, { cashBalance: newCash.toString() });

      // 5. Query open position
      const posQuery = await this.db.collection('positions')
        .where('telegramId', '==', params.telegramId)
        .where('sessionId', '==', params.sessionId)
        .where('chain', '==', params.chain)
        .where('status', '==', 'open')
        .get();

      const existingPos = posQuery.docs
        .map(d => d.data() as Position)
        .find(p => params.chain === 'solana' ? p.tokenAddress === params.tokenAddress : p.tokenAddress.toLowerCase() === params.tokenAddress.toLowerCase());

      const now = Date.now();
      let position: Position;
      const fillId = `fill_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;

      if (!existingPos) {
        const positionId = `pos_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
        position = {
          positionId,
          sessionId: params.sessionId,
          telegramId: params.telegramId,
          chain: params.chain,
          tokenAddress: params.tokenAddress,
          pairAddress: params.pairAddress,
          dexId: params.dexId,
          symbol: params.symbol,
          tokenName: params.tokenName,
          imageUrl: params.imageUrl,
          status: 'open',
          totalQuantityBought: params.quantityBought,
          totalCostBasisBought: params.totalDebitUsd,
          remainingQuantity: params.quantityBought,
          remainingCostBasis: params.totalDebitUsd,
          averageEntryPrice: D(params.totalDebitUsd).dividedBy(D(params.quantityBought)).toString(),
          totalQuantitySold: '0',
          totalRealisedProceeds: '0',
          totalRealisedPnl: '0',
          createdAt: now,
          updatedAt: now,
        };
        t.set(this.db.collection('positions').doc(positionId), position);
      } else {
        position = { ...existingPos };
        const oldQty = D(position.remainingQuantity);
        const addQty = D(params.quantityBought);
        const newRemainingQty = oldQty.plus(addQty);

        const oldCost = D(position.remainingCostBasis);
        const addCost = D(params.totalDebitUsd);
        const newRemainingCost = oldCost.plus(addCost);

        const newAvgEntry = newRemainingCost.dividedBy(newRemainingQty);

        position.totalQuantityBought = D(position.totalQuantityBought).plus(addQty).toString();
        position.totalCostBasisBought = D(position.totalCostBasisBought).plus(addCost).toString();
        position.remainingQuantity = newRemainingQty.toString();
        position.remainingCostBasis = newRemainingCost.toString();
        position.averageEntryPrice = newAvgEntry.toString();
        position.updatedAt = now;
        if (params.imageUrl && !position.imageUrl) {
          position.imageUrl = params.imageUrl;
        }

        t.set(this.db.collection('positions').doc(position.positionId), position);
      }

      // 6. Record trade fill
      const fill: TradeFill = {
        fillId,
        sessionId: params.sessionId,
        telegramId: params.telegramId,
        positionId: position.positionId,
        side: 'buy',
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        pairAddress: params.pairAddress,
        symbol: params.symbol,
        tokenName: params.tokenName,
        quotedPriceUsd: params.quotedPriceUsd,
        executedPriceUsd: params.executedPriceUsd,
        quantity: params.quantityBought,
        cashDebitOrCredit: params.totalDebitUsd,
        feeUsd: params.feeUsd,
        slippageAppliedPercent: params.slippagePercent,
        timestamp: now,
        tradeNote: params.tradeNote,
      };
      t.set(this.db.collection('fills').doc(fillId), fill);

      return { fill, position, newCashBalance: newCash.toString() };
    });
  }

  public async executeSellTransaction(params: {
    intentId: string;
    telegramId: number;
    sessionId: string;
    positionId: string;
    sellFraction: string;
    executedPriceUsd: string;
    quotedPriceUsd: string;
    feeUsd: string;
    slippagePercent: string;
    tradeNote?: string;
  }): Promise<{ fill: TradeFill; position: Position; newCashBalance: string; realisedPnlUsd: string; isFullClosure: boolean }> {
    return this.db.runTransaction(async (t) => {
      // 1. Verify intent
      const intentRef = this.db.collection('intents').doc(params.intentId);
      const intentSnap = await t.get(intentRef);
      if (!intentSnap.exists) throw new Error('Confirmation intent not found.');
      const intent = intentSnap.data() as PendingActionIntent;
      if (intent.executed) throw new Error('Confirmation already executed.');
      if (intent.expiresAt < Date.now()) throw new Error('Confirmation expired.');
      if (intent.telegramId !== params.telegramId || intent.sessionId !== params.sessionId) {
        throw new Error('Unauthorized session for this order.');
      }

      // 2. Verify session & position
      const sessionRef = this.db.collection('sessions').doc(params.sessionId);
      const sessionSnap = await t.get(sessionRef);
      if (!sessionSnap.exists) throw new Error('Session not found.');
      const session = sessionSnap.data() as AccountSession;
      if (session.status !== 'active') throw new Error('Session is archived.');

      const posRef = this.db.collection('positions').doc(params.positionId);
      const posSnap = await t.get(posRef);
      if (!posSnap.exists) throw new Error('Position not found.');
      const position = posSnap.data() as Position;
      if (position.status !== 'open' || position.sessionId !== params.sessionId) {
        throw new Error('Position already closed or not belonging to this session.');
      }

      const remainingQty = D(position.remainingQuantity);
      if (remainingQty.lte(0)) {
        throw new Error('Position has zero remaining balance.');
      }

      const fraction = D(params.sellFraction);
      if (fraction.lte(0) || fraction.gt(1)) {
        throw new Error('Invalid sell fraction.');
      }

      const isFullClosure = fraction.gte(0.999999);
      const qtyToSell = isFullClosure ? remainingQty : remainingQty.times(fraction);
      const preSaleRemainingCost = D(position.remainingCostBasis);
      const allocatedSaleCost = isFullClosure ? preSaleRemainingCost : preSaleRemainingCost.times(fraction);

      const grossProceeds = qtyToSell.times(D(params.executedPriceUsd));
      const fee = D(params.feeUsd);
      const netProceeds = grossProceeds.minus(fee);
      const realisedPnl = netProceeds.minus(allocatedSaleCost);

      // 3. Mark intent executed
      t.update(intentRef, { executed: true });

      // 4. Update Cash
      const newCash = D(session.cashBalance).plus(netProceeds);
      t.update(sessionRef, { cashBalance: newCash.toString() });

      // 5. Update Position
      const now = Date.now();
      const newRemainingQty = isFullClosure ? D(0) : remainingQty.minus(qtyToSell);
      const newRemainingCost = isFullClosure ? D(0) : preSaleRemainingCost.minus(allocatedSaleCost);

      const updatedPos: Partial<Position> = {
        remainingQuantity: newRemainingQty.toString(),
        remainingCostBasis: newRemainingCost.toString(),
        totalQuantitySold: D(position.totalQuantitySold).plus(qtyToSell).toString(),
        totalRealisedProceeds: D(position.totalRealisedProceeds).plus(netProceeds).toString(),
        totalRealisedPnl: D(position.totalRealisedPnl).plus(realisedPnl).toString(),
        updatedAt: now,
      };

      if (isFullClosure) {
        updatedPos.status = 'closed';
        updatedPos.closedAt = now;
      }

      t.update(posRef, updatedPos);

      // 6. Record Fill
      const fillId = `fill_${params.telegramId}_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const fill: TradeFill = {
        fillId,
        sessionId: params.sessionId,
        telegramId: params.telegramId,
        positionId: position.positionId,
        side: 'sell',
        chain: position.chain,
        tokenAddress: position.tokenAddress,
        pairAddress: position.pairAddress,
        symbol: position.symbol,
        tokenName: position.tokenName,
        quotedPriceUsd: params.quotedPriceUsd,
        executedPriceUsd: params.executedPriceUsd,
        quantity: qtyToSell.toString(),
        cashDebitOrCredit: netProceeds.toString(),
        feeUsd: params.feeUsd,
        slippageAppliedPercent: params.slippagePercent,
        timestamp: now,
        tradeNote: params.tradeNote,
      };
      t.set(this.db.collection('fills').doc(fillId), fill);

      return {
        fill,
        position: { ...position, ...updatedPos } as Position,
        newCashBalance: newCash.toString(),
        realisedPnlUsd: realisedPnl.toString(),
        isFullClosure,
      };
    });
  }
}

/**
 * Instantiate Firestore or fallback to persistent local store
 */
export function createStorage(opts?: { persist?: boolean; filePath?: string }): IStorage {
  try {
    if (config.gcpProjectId || process.env.GOOGLE_APPLICATION_CREDENTIALS || config.firestoreEmulatorHost) {
      console.log(`[Storage] Initializing Firestore (project: ${config.gcpProjectId || 'default'}, emulator: ${config.firestoreEmulatorHost || 'none'})...`);
      const firestore = new Firestore({
        projectId: config.gcpProjectId,
        databaseId: config.firestoreDatabaseId,
      });
      return new GoogleCloudFirestoreStorage(firestore);
    }
  } catch (err) {
    console.warn('[Storage] Google Cloud Firestore not configured or failed to initialize. Falling back to persistent local store:', err);
  }

  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || Boolean(process.env.VITEST);
  const shouldPersist = opts?.persist !== undefined ? opts.persist : !isTest;
  const targetFile = opts?.filePath || path.join(process.cwd(), 'data', 'paper_trader_db.json');

  if (shouldPersist) {
    console.log(`[Storage] Using Persistent Local Store (${targetFile})`);
    return new InMemoryStorage(targetFile);
  }

  console.log('[Storage] Using In-Memory Transactional Store (Test mode)');
  return new InMemoryStorage();
}

export const storage = createStorage();
