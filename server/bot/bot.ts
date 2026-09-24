/**
 * @file server/bot/bot.ts
 * Main grammY Telegram bot implementation for DJN Paper Trader
 */

import { Bot, InlineKeyboard } from 'grammy';
import { config, isBotConfigured } from '../config.js';
import { storage } from '../storage/firestore.js';
import { paperTrading } from '../services/trading.js';
import { dexScreener, getChainDisplayName } from '../dexscreener/adapter.js';
import { cardRenderer } from '../services/cardRenderer.js';
import { escapeHtml } from '../utils/security.js';
import { D, formatPercent, formatPrice, formatQuantity, formatUsd } from '../utils/decimal.js';
import { PnlCardSnapshot, SupportedChain } from '../types.js';

// Initialize Bot instance with dummy fallback token if not configured yet (avoids crash during module load)
const botToken = isBotConfigured() ? config.telegramBotToken : '000000000:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK';
export const bot = new Bot(botToken);

// Middleware: ensure private chat & update deduplication
bot.use(async (ctx, next) => {
  // Account operations are strictly for private chats
  if (ctx.chat && ctx.chat.type !== 'private') {
    await ctx.reply('DJN Paper Trader only operates in private chats for your privacy and portfolio security.');
    return;
  }

  // Deduplicate updates from webhook retries
  if (ctx.update?.update_id) {
    const isProcessed = await storage.isUpdateProcessed(ctx.update.update_id);
    if (isProcessed) {
      return; // Ignore duplicate update safely
    }
    await storage.markUpdateProcessed(ctx.update.update_id);
  }

  await next();
});

/**
 * Standard Main Menu Keyboard
 */
export function getMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔎 Buy / Find Token', 'm:find')
    .text('📊 Positions', 'm:pos')
    .row()
    .text('💰 Balance', 'm:bal')
    .text('📜 Trade History', 'm:hist')
    .row()
    .text('📈 Performance', 'm:perf')
    .text('⚙️ Settings', 'm:set')
    .row()
    .text('ℹ️ Help', 'm:help');
}

/**
 * /start command: queries Firestore for existing sessions and positions to resume across restarts
 */
bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const displayName = ctx.from?.first_name || ctx.from?.username || undefined;

  // 1. Query Firestore / persistent storage for any existing session associated with the user's Telegram ID
  const existingActiveSession = await storage.getActiveSession(telegramId);
  const { user, session, isNewUser } = await storage.getOrCreateUser(telegramId, displayName);

  // 2. Query persistent storage for open positions belonging to this session
  const openPositions = await storage.getOpenPositions(telegramId, session.sessionId);

  let statusMsg: string;
  let keyboard: InlineKeyboard;

  if (isNewUser) {
    statusMsg = `🎉 <b>Your practice account has been funded with $1,000.00 virtual USD!</b>`;
    keyboard = getMainMenuKeyboard();
  } else {
    // Returning user with session resumed from Firestore/persistent storage
    const positionCount = openPositions.length;
    statusMsg = `💼 <b>Welcome back! Session successfully resumed from database.</b>\n` +
      `🛡️ <i>Storage Engine: ${storage.getStorageType()}</i>\n\n` +
      `• <b>Available Cash:</b> <code>${formatUsd(session.cashBalance)}</code>\n` +
      `• <b>Open Positions:</b> <b>${positionCount} active</b>`;

    if (positionCount > 0) {
      statusMsg += `\n\n📊 <b>Active Positions (resumed across restarts):</b>\n`;
      const displayPositions = openPositions.slice(0, 4);
      for (const pos of displayPositions) {
        statusMsg += `• <b>${escapeHtml(pos.symbol)}</b> (${pos.chain.toUpperCase()}): ` +
          `<code>${formatQuantity(pos.remainingQuantity)}</code> @ <code>${formatPrice(pos.averageEntryPrice)}</code>\n`;
      }
      if (positionCount > 4) {
        statusMsg += `<i>...and ${positionCount - 4} more. Tap below to manage them.</i>\n`;
      }

      keyboard = new InlineKeyboard()
        .text(`📊 View ${positionCount} Position${positionCount > 1 ? 's' : ''}`, 'm:pos')
        .text('🔎 Buy Token', 'm:find')
        .row()
        .text('💰 Balance', 'm:bal')
        .text('📜 Trade History', 'm:hist')
        .row()
        .text('📈 Performance', 'm:perf')
        .text('⚙️ Settings', 'm:set');
    } else {
      keyboard = getMainMenuKeyboard();
    }
  }

  const welcomeText = `
👋 <b>Welcome to DJN Paper Trader.</b>

Practise memecoin trading with real market prices and virtual money.
No wallet. No deposits. No blockchain transactions.

${statusMsg}

📌 <b>Paste a token contract address or DEX Screener link to begin.</b>
`.trim();

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

/**
 * /buy command
 */
bot.command('buy', async (ctx) => {
  const text = ctx.message?.text?.trim() || '';
  const parts = text.split(/\s+/);
  if (parts.length > 1) {
    const inputArg = parts.slice(1).join(' ');
    const parsed = dexScreener.parseInput(inputArg);
    if (parsed) {
      const chain = parsed.chain || 'solana';
      await handleTokenLookup(ctx, parsed.address, chain, parsed.isPairUrl);
      return;
    }
  }

  await ctx.reply(
    '🔍 <b>Find & Buy Token</b>\n\nPaste any token contract address or DEX Screener URL across any chain (Solana, Ronin, Base, Ethereum, BSC, Arbitrum, Polygon, Avalanche, Sui, TON, etc.):',
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📊 View Positions', 'm:pos').text('🔙 Main Menu', 'm:menu'),
    }
  );
});

/**
 * /balance command
 */
bot.command('balance', async (ctx) => {
  await handleBalanceView(ctx);
});

/**
 * /positions command
 */
bot.command('positions', async (ctx) => {
  await handlePositionsView(ctx);
});

/**
 * /portfolio command (alias for /positions)
 */
bot.command('portfolio', async (ctx) => {
  await handlePositionsView(ctx);
});

/**
 * /sell command:
 * Usage:
 * /sell -> shows open positions with one-click sell buttons
 * /sell <symbol> [25% | 50% | 100% | all] -> e.g. /sell PEPE 50%
 */
bot.command('sell', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const session = await storage.getActiveSession(telegramId);
  const openPositions = await storage.getOpenPositions(telegramId, session?.sessionId);

  if (openPositions.length === 0) {
    await ctx.reply(
      '📊 <b>No Open Positions to Sell</b>\n\nYou currently have no open paper trading positions. Paste a token contract address or DEX Screener URL to buy tokens first!',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔎 Buy Token', 'm:find').text('🔙 Main Menu', 'm:menu'),
      }
    );
    return;
  }

  const text = ctx.message?.text?.trim() || '';
  const parts = text.split(/\s+/).slice(1);

  if (parts.length > 0) {
    const targetSymbolOrAddr = parts[0].toLowerCase();
    const matchedPosition = openPositions.find(
      (p) =>
        p.symbol.toLowerCase() === targetSymbolOrAddr ||
        p.tokenAddress.toLowerCase() === targetSymbolOrAddr ||
        p.tokenName.toLowerCase().includes(targetSymbolOrAddr)
    );

    if (matchedPosition) {
      let fraction = '1.00';
      if (parts.length > 1) {
        const fracStr = parts[1].toLowerCase().replace('%', '');
        if (fracStr === '25' || fracStr === '0.25') fraction = '0.25';
        else if (fracStr === '50' || fracStr === '0.50' || fracStr === 'half') fraction = '0.50';
        else if (fracStr === '75' || fracStr === '0.75') fraction = '0.75';
        else if (fracStr === '100' || fracStr === '1.00' || fracStr === 'all') fraction = '1.00';
      }
      await handleSellPreview(ctx, matchedPosition.positionId, fraction);
      return;
    }
  }

  // If no arguments or not matched, show interactive menu for each open position
  let msg = `📉 <b>Select an Open Position to Sell:</b>\n\n`;
  const kb = new InlineKeyboard();

  for (const pos of openPositions) {
    msg += `• <b>${escapeHtml(pos.symbol)}</b> (${pos.chain.toUpperCase()}): <code>${formatQuantity(pos.remainingQuantity)}</code> remaining\n`;
    kb.text(`Sell 50% ${pos.symbol}`, `sp:0.50:${pos.positionId}`)
      .text(`Sell 100% ${pos.symbol}`, `sp:1.00:${pos.positionId}`)
      .row();
  }

  kb.text('📊 View All Positions', 'm:pos').text('🔙 Main Menu', 'm:menu');

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});

/**
 * /pnl command:
 * Usage:
 * /pnl -> shows open positions with one-click PnL card generators
 * /pnl <symbol> -> directly generates high-resolution PnL card for that token
 */
bot.command('pnl', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const session = await storage.getActiveSession(telegramId);
  const openPositions = await storage.getOpenPositions(telegramId, session?.sessionId);

  if (openPositions.length === 0) {
    await ctx.reply(
      '🖼️ <b>No Positions for P&L Card</b>\n\nYou currently have no open positions. Open a paper trade first using /buy or paste a token address!',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔎 Buy Token', 'm:find').text('🔙 Main Menu', 'm:menu'),
      }
    );
    return;
  }

  const text = ctx.message?.text?.trim() || '';
  const parts = text.split(/\s+/).slice(1);

  if (parts.length > 0) {
    const targetSymbolOrAddr = parts[0].toLowerCase();
    const matchedPosition = openPositions.find(
      (p) =>
        p.symbol.toLowerCase() === targetSymbolOrAddr ||
        p.tokenAddress.toLowerCase() === targetSymbolOrAddr ||
        p.tokenName.toLowerCase().includes(targetSymbolOrAddr)
    );

    if (matchedPosition) {
      await handleSharePnlCard(ctx, matchedPosition.positionId);
      return;
    }
  }

  // If single position, generate card right away!
  if (openPositions.length === 1) {
    await handleSharePnlCard(ctx, openPositions[0].positionId);
    return;
  }

  // Multiple positions: prompt user to pick which token
  let msg = `🎨 <b>Select a Position to Generate P&L Card:</b>\n\n`;
  const kb = new InlineKeyboard();

  for (const pos of openPositions) {
    msg += `• <b>${escapeHtml(pos.symbol)}</b> (${pos.chain.toUpperCase()})\n`;
    kb.text(`🖼️ P&L Card: ${pos.symbol}`, `card:${pos.positionId}`).row();
  }

  kb.text('📊 View Positions', 'm:pos').text('🔙 Main Menu', 'm:menu');

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});

/**
 * /history command
 */
bot.command('history', async (ctx) => {
  await handleHistoryView(ctx);
});

/**
 * /performance command
 */
bot.command('performance', async (ctx) => {
  await handlePerformanceView(ctx);
});

/**
 * /settings command
 */
bot.command('settings', async (ctx) => {
  await handleSettingsView(ctx);
});

/**
 * /help command
 */
bot.command('help', async (ctx) => {
  await handleHelpView(ctx);
});

// ==========================================
// Text Message Handler (Addresses & Search)
// ==========================================
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  const telegramId = ctx.from.id;

  // If command already handled by bot.command, ignore
  if (text.startsWith('/')) {
    return;
  }

  // Ensure user exists
  const { user, session } = await storage.getOrCreateUser(telegramId, ctx.from.first_name);

  // Check if user is typing a custom buy amount after clicking "Custom Amount"
  // Let's check if there is an active custom input prompt state or parse as address
  const parsed = dexScreener.parseInput(text, user.settings.defaultChain);

  if (!parsed) {
    // Check if user typed a numeric dollar amount (e.g. "75" or "$75")
    const dollarMatch = text.match(/^\$?([0-9]+(?:\.[0-9]{1,2})?)$/);
    if (dollarMatch) {
      await ctx.reply(
        `💡 To buy $${dollarMatch[1]}, first paste a token contract address or select an open position!`,
        { reply_markup: getMainMenuKeyboard() }
      );
      return;
    }

    await ctx.reply(
      '❌ <b>Unrecognized input.</b>\n\nPlease paste a valid token contract address (Solana base58, EVM 0x...) or a recognised DEX Screener URL.',
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(),
      }
    );
    return;
  }

  // If EVM address without specified chain, ask user to select chain
  if (parsed.ambiguousEvm && !parsed.chain) {
    const kb = new InlineKeyboard()
      .text('🔷 Base', `c:base:${parsed.address}`)
      .text('🗡️ Ronin', `c:ronin:${parsed.address}`)
      .row()
      .text('💎 Ethereum', `c:ethereum:${parsed.address}`)
      .text('🟡 BSC', `c:bsc:${parsed.address}`)
      .row()
      .text('⚡ Arbitrum', `c:arbitrum:${parsed.address}`)
      .text('🟣 Polygon', `c:polygon:${parsed.address}`)
      .row()
      .text('🔙 Cancel', 'm:menu');

    await ctx.reply(
      `🌐 <b>Select Network for Address:</b>\n<code>${escapeHtml(parsed.address)}</code>\n\n<i>Or paste a direct DEX Screener link for instant detection!</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    );
    return;
  }

  const chain = parsed.chain || user.settings.defaultChain;
  await handleTokenLookup(ctx, parsed.address, chain, parsed.isPairUrl);
});

// ==========================================
// Callback Queries
// ==========================================

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const telegramId = ctx.from.id;
  await ctx.answerCallbackQuery(); // Acknowledge promptly

  const { user, session } = await storage.getOrCreateUser(telegramId, ctx.from.first_name);

  // 1. Navigation callbacks
  if (data === 'm:menu') {
    await ctx.editMessageText('🏠 <b>Main Menu:</b>\nSelect an option below:', {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
    return;
  }
  if (data === 'm:find') {
    await ctx.reply('🔍 Paste any token contract address or DEX Screener URL into this chat:');
    return;
  }
  if (data === 'm:pos') {
    await handlePositionsView(ctx, true);
    return;
  }
  if (data === 'm:bal') {
    await handleBalanceView(ctx, true);
    return;
  }
  if (data === 'm:hist') {
    await handleHistoryView(ctx, true);
    return;
  }
  if (data === 'm:perf') {
    await handlePerformanceView(ctx, true);
    return;
  }
  if (data === 'm:set') {
    await handleSettingsView(ctx, true);
    return;
  }
  if (data === 'm:help') {
    await handleHelpView(ctx, true);
    return;
  }

  // 2. Chain Selection for EVM: c:<chain>:<addr>
  if (data.startsWith('c:')) {
    const [, chain, address] = data.split(':');
    await handleTokenLookup(ctx, address, chain as SupportedChain);
    return;
  }

  // 3. Token detail refresh: t:<chain>:<addr>
  if (data.startsWith('t:')) {
    const parts = data.split(':');
    const chain = parts[1] as SupportedChain;
    const address = parts[2];
    await handleTokenLookup(ctx, address, chain);
    return;
  }

  // 4. Prepare Buy Preset: bp:<spend>:<chain>:<addr>
  if (data.startsWith('bp:')) {
    const [, spend, chain, addr] = data.split(':');
    await handleBuyPreview(ctx, addr, chain as SupportedChain, spend);
    return;
  }

  // 5. Confirm Buy: cb:<intentId>
  if (data.startsWith('cb:')) {
    const intentId = data.substring(3);
    await handleConfirmBuy(ctx, intentId);
    return;
  }

  // 6. Position Detail: p:<posId>
  if (data.startsWith('p:')) {
    const posId = data.substring(2);
    await handleSinglePositionView(ctx, posId, true);
    return;
  }

  // 7. Prepare Sell: sp:<fraction>:<posId>
  if (data.startsWith('sp:')) {
    const [, fraction, posId] = data.split(':');
    await handleSellPreview(ctx, posId, fraction);
    return;
  }

  // 8. Confirm Sell: cs:<intentId>
  if (data.startsWith('cs:')) {
    const intentId = data.substring(3);
    await handleConfirmSell(ctx, intentId);
    return;
  }

  // 9. Share P&L Card: card:<posId>
  if (data.startsWith('card:')) {
    const posId = data.substring(5);
    await handleSharePnlCard(ctx, posId);
    return;
  }

  // 10. Settings actions
  if (data === 'set:mode') {
    const newSettings = await storage.updateUserSettings(telegramId, {
      simulatedCosts: !user.settings.simulatedCosts,
    });
    await ctx.reply(
      `⚙️ Practice mode updated: <b>${newSettings.simulatedCosts ? 'SIMULATED COSTS (fees & slippage)' : 'SIMPLE PRICE TRACKING (zero fees)'}</b>`,
      { parse_mode: 'HTML' }
    );
    await handleSettingsView(ctx);
    return;
  }

  if (data.startsWith('theme:')) {
    const theme = data.substring(6) as 'pepe' | 'doge' | 'chad';
    await storage.updateUserSettings(telegramId, { cardTheme: theme });
    await ctx.reply(`🎨 Default P&L card theme set to <b>${theme.toUpperCase()}</b>!`, { parse_mode: 'HTML' });
    await handleSettingsView(ctx);
    return;
  }

  if (data === 'rst:ask') {
    const kb = new InlineKeyboard()
      .text('🚨 YES, RESET MY ACCOUNT', 'rst:confirm')
      .row()
      .text('❌ Cancel', 'm:set');

    await ctx.reply(
      '⚠️ <b>RESET PRACTICE ACCOUNT?</b>\n\nThis will archive your current practice session and restore your available cash to exactly <b>$1,000.00 virtual USD</b>.\n\nAll historical trades and P&L cards will remain preserved in history.',
      { parse_mode: 'HTML', reply_markup: kb }
    );
    return;
  }

  if (data === 'rst:confirm') {
    const { newSession } = await storage.resetAccountSession(telegramId);
    await ctx.reply(
      `✅ <b>Account Reset Complete!</b>\n\nA fresh practice session has started with <b>${formatUsd(newSession.cashBalance)} virtual USD</b>.`,
      { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard()}
    );
    return;
  }

  if (data === 'cx') {
    await ctx.reply('❌ Action cancelled.', { reply_markup: getMainMenuKeyboard() });
    return;
  }
});

// ==========================================
// Helper Handlers
// ==========================================

async function handleTokenLookup(ctx: any, tokenAddress: string, chain: SupportedChain, isPairUrl: boolean = false) {
  await ctx.reply('🔄 Fetching live DEX Screener market data...');

  const quote = await dexScreener.getTokenQuote(tokenAddress, chain);
  if (!quote || D(quote.priceUsd).lte(0)) {
    await ctx.reply(
      `❌ <b>Token or Pair Unavailable</b>\n\nCould not find eligible pair pricing for:\n<code>${escapeHtml(tokenAddress)}</code> on <b>${chain.toUpperCase()}</b>.\n\nPlease check the contract address and ensure liquidity exists.`,
      { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }
    );
    return;
  }

  const { token } = quote;
  const cleanName = escapeHtml(token.name);
  const cleanSymbol = escapeHtml(token.symbol);
  const price = formatPrice(quote.priceUsd);
  const marketCap = quote.marketCapUsd ? formatUsd(quote.marketCapUsd) : 'Unavailable';
  const fdv = quote.fdvUsd ? formatUsd(quote.fdvUsd) : 'Unavailable';
  const liquidity = quote.liquidityUsd ? formatUsd(quote.liquidityUsd) : 'Unavailable';
  const volume24h = quote.volume24hUsd ? formatUsd(quote.volume24hUsd) : 'Unavailable';

  const m5 = quote.priceChange.m5 != null ? formatPercent(quote.priceChange.m5) : 'N/A';
  const h1 = quote.priceChange.h1 != null ? formatPercent(quote.priceChange.h1) : 'N/A';
  const h6 = quote.priceChange.h6 != null ? formatPercent(quote.priceChange.h6) : 'N/A';
  const h24 = quote.priceChange.h24 != null ? formatPercent(quote.priceChange.h24) : 'N/A';

  // Pair age calculation
  let pairAgeStr = 'Unavailable';
  if (token.pairCreatedAt) {
    const ageMs = Date.now() - token.pairCreatedAt;
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    pairAgeStr = days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;
  }

  const quoteTime = new Date(quote.retrievedAt).toTimeString().split(' ')[0] + ' UTC';

  const text = `
💎 <b>${cleanName} (${cleanSymbol})</b>
🌐 <b>Network:</b> ${getChainDisplayName(chain).toUpperCase()}
📝 <b>Address:</b> <code>${escapeHtml(token.address)}</code>

💵 <b>Price (USD):</b> <code>${price}</code>
📊 <b>Market Cap:</b> ${marketCap}
🏦 <b>FDV (Fully Diluted):</b> ${fdv}
💧 <b>Liquidity:</b> ${liquidity} | <b>24h Vol:</b> ${volume24h}
📈 <b>Changes:</b> 5m: <code>${m5}</code> | 1h: <code>${h1}</code> | 6h: <code>${h6}</code> | 24h: <code>${h24}</code>

🏛️ <b>DEX &amp; Pair:</b> ${token.dexId.toUpperCase()} (<code>${escapeHtml(token.pairAddress.substring(0, 8))}...</code>)
⏳ <b>Pair age:</b> ${pairAgeStr}
🕒 <b>Quote Retrieved At:</b> ${quoteTime}
`.trim();

  // Buy presets: 25, 50, 100
  const kb = new InlineKeyboard()
    .text('Buy $25', `bp:25:${chain}:${token.address}`)
    .text('Buy $50', `bp:50:${chain}:${token.address}`)
    .text('Buy $100', `bp:100:${chain}:${token.address}`)
    .row()
    .url('🔗 DEX Screener', token.url || `https://dexscreener.com/${chain}/${token.pairAddress}`)
    .text('🔄 Refresh', `t:${chain}:${token.address}`)
    .row()
    .text('📊 Positions', 'm:pos')
    .text('🔙 Main Menu', 'm:menu');

  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}

async function handleBuyPreview(ctx: any, tokenAddress: string, chain: SupportedChain, spendAmountUsd: string) {
  const telegramId = ctx.from.id;
  const user = await storage.getUser(telegramId);
  const session = await storage.getActiveSession(telegramId);
  if (!user || !session) return;

  try {
    const { preview, quote } = await paperTrading.prepareBuyPreview({
      telegramId,
      sessionId: session.sessionId,
      tokenAddress,
      chain,
      spendAmountUsd,
      userSettings: user.settings,
    });

    const cleanSymbol = escapeHtml(quote.token.symbol);
    const modeLabel = preview.simulatedCosts ? '⚠️ Simulated Costs Mode (fees & slippage applied)' : '✨ Simple Mode (zero fees)';

    const previewMsg = `
🛒 <b>Confirm Paper Buy Order</b>

• <b>Token:</b> ${cleanSymbol} (${chain.toUpperCase()})
• <b>Spend Amount:</b> <code>${formatUsd(preview.spendAmountUsd)}</code>
• <b>Quoted Price:</b> <code>${formatPrice(preview.quotedPriceUsd)}</code>
• <b>Simulated Fill Price:</b> <code>${formatPrice(preview.executedPriceUsd)}</code>
• <b>Estimated Quantity:</b> <code>${formatQuantity(preview.estimatedQuantity)} ${cleanSymbol}</code>
${preview.simulatedCosts ? `• <b>Simulated Fee:</b> <code>${formatUsd(preview.feeUsd)}</code>\n• <b>Slippage:</b> <code>${preview.slippagePercent}%</code>` : ''}
• <b>Mode:</b> ${modeLabel}
• <b>Available Cash:</b> <code>${formatUsd(session.cashBalance)}</code>

<i>Quote valid for 30 seconds.</i>
`.trim();

    const kb = new InlineKeyboard()
      .text('✅ Confirm Buy', `cb:${preview.intentId}`)
      .text('❌ Cancel', 'cx');

    await ctx.reply(previewMsg, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Order Preview Error:</b>\n${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
  }
}

async function handleConfirmBuy(ctx: any, intentId: string) {
  const telegramId = ctx.from.id;
  await ctx.reply('⏳ Executing paper buy transaction...');

  try {
    const { fill, position, newCashBalance } = await paperTrading.confirmBuy({
      intentId,
      telegramId,
    });

    const receipt = `
🎉 <b>Paper Buy Executed Successfully!</b>

• <b>Token:</b> ${escapeHtml(fill.symbol)} (${fill.chain.toUpperCase()})
• <b>Total Spent:</b> <code>${formatUsd(fill.cashDebitOrCredit)}</code>
• <b>Execution Price:</b> <code>${formatPrice(fill.executedPriceUsd)}</code>
• <b>Quantity Received:</b> <code>${formatQuantity(fill.quantity)} ${escapeHtml(fill.symbol)}</code>
• <b>New Cash Balance:</b> <code>${formatUsd(newCashBalance)}</code>
• <b>Position Total Holdings:</b> <code>${formatQuantity(position.remainingQuantity)} ${escapeHtml(fill.symbol)}</code>
• <b>Average Entry:</b> <code>${formatPrice(position.averageEntryPrice)}</code>

📌 <i>All funds are simulated practice credits.</i>
`.trim();

    const kb = new InlineKeyboard()
      .text('🔴 Sell 100%', `sp:1.00:${position.positionId}`)
      .text('🟡 Sell 50%', `sp:0.50:${position.positionId}`)
      .row()
      .text('📊 Position Details', `p:${position.positionId}`)
      .text('🖼️ Share P&L Card', `card:${position.positionId}`)
      .row()
      .text('🔙 Main Menu', 'm:menu');

    await ctx.reply(receipt, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Buy Execution Failed:</b>\n${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
  }
}

async function handlePositionsView(ctx: any, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  const session = await storage.getActiveSession(telegramId);
  const user = await storage.getUser(telegramId);
  if (!user) return;

  const positions = await storage.getOpenPositions(telegramId, session?.sessionId);
  if (positions.length === 0) {
    const text = '📊 <b>Open Positions: None</b>\n\nYou currently have no open paper trading positions. Paste a contract address or DEX Screener URL to make your first trade!';
    const kb = new InlineKeyboard().text('🔎 Buy Token', 'm:find').text('🔙 Main Menu', 'm:menu');
    if (isEdit) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  let text = `📊 <b>Your Open Positions (${positions.length})</b>\n\n`;
  const kb = new InlineKeyboard();

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const valuation = await paperTrading.valuePosition(pos, user.settings);
    const pnlUsd = formatUsd(valuation.unrealisedPnlUsd, true);
    const pnlPct = formatPercent(valuation.unrealisedPnlPercent, true);

    text += `<b>${i + 1}. ${escapeHtml(pos.symbol)}</b> (${pos.chain.toUpperCase()})\n`;
    text += `• Holdings: <code>${formatQuantity(pos.remainingQuantity)}</code>\n`;
    text += `• Avg Entry: <code>${formatPrice(pos.averageEntryPrice)}</code> | Cur: <code>${formatPrice(valuation.currentPriceUsd)}</code>\n`;
    text += `• Value: <code>${formatUsd(valuation.markedMarketValueUsd)}</code> | Unrealised P&L: <b>${pnlUsd} (${pnlPct})</b>\n\n`;

    kb.text(`🔴 Sell 100%`, `sp:1.00:${pos.positionId}`)
      .text(`🟡 Sell 50%`, `sp:0.50:${pos.positionId}`)
      .text(`🖼️ Card`, `card:${pos.positionId}`)
      .row();
  }

  kb.text('🔄 Refresh Prices', 'm:pos').text('🔙 Main Menu', 'm:menu');

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      // Content identical; ignore error
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handleSinglePositionView(ctx: any, positionId: string, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  const user = await storage.getUser(telegramId);
  let position = await storage.getPosition(positionId);

  if (!position || String(position.telegramId) !== String(telegramId)) {
    const userOpenPositions = await storage.getOpenPositions(telegramId);
    position = userOpenPositions.find((p) => p.positionId === positionId || p.status === 'open') || null;
  }

  if (!position || String(position.telegramId) !== String(telegramId)) {
    const text = '❌ Position not found or already closed.';
    const kb = new InlineKeyboard().text('📊 All Positions', 'm:pos').text('🔙 Main Menu', 'm:menu');
    if (isEdit) {
      try {
        await ctx.editMessageText(text, { reply_markup: kb });
      } catch {
        await ctx.reply(text, { reply_markup: kb });
      }
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  const valuation = await paperTrading.valuePosition(position, user?.settings);
  const cleanSymbol = escapeHtml(position.symbol);
  const cleanName = escapeHtml(position.tokenName);

  const text = `
🎯 <b>Position: ${cleanName} (${cleanSymbol})</b>
🌐 <b>Network:</b> ${position.chain.toUpperCase()}
📝 <b>Address:</b> <code>${escapeHtml(position.tokenAddress)}</code>

• <b>Remaining Quantity:</b> <code>${formatQuantity(position.remainingQuantity)}</code>
• <b>Average Entry Price:</b> <code>${formatPrice(position.averageEntryPrice)}</code>
• <b>Current Market Price:</b> <code>${formatPrice(valuation.currentPriceUsd)}</code> ${valuation.isStale ? '(⚠️ Stale Quote)' : ''}
• <b>Remaining Cost Basis:</b> <code>${formatUsd(position.remainingCostBasis)}</code>
• <b>Market Value:</b> <code>${formatUsd(valuation.markedMarketValueUsd)}</code>
• <b>Unrealised P&amp;L:</b> <b>${formatUsd(valuation.unrealisedPnlUsd, true)} (${formatPercent(valuation.unrealisedPnlPercent, true)})</b>
• <b>Realised P&amp;L (Partial sales):</b> <code>${formatUsd(position.totalRealisedPnl, true)}</code>
• <b>Status:</b> ${position.status.toUpperCase()}
`.trim();

  const kb = new InlineKeyboard()
    .text('🔴 Sell 100%', `sp:1.00:${positionId}`)
    .text('🟡 Sell 50%', `sp:0.50:${positionId}`)
    .text('Sell 25%', `sp:0.25:${positionId}`)
    .row()
    .text('🖼️ Share P&L Card', `card:${positionId}`)
    .text('🔄 Refresh', `p:${positionId}`)
    .row()
    .text('📊 All Positions', 'm:pos')
    .text('🔙 Main Menu', 'm:menu');

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      // Content identical; ignore error
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handleSellPreview(ctx: any, positionId: string, sellFraction: string) {
  const telegramId = ctx.from.id;
  const user = await storage.getUser(telegramId);
  if (!user) return;

  try {
    const { preview, position } = await paperTrading.prepareSellPreview({
      telegramId,
      positionId,
      sellFraction,
      userSettings: user.settings,
    });

    const pctLabel = `${(parseFloat(sellFraction) * 100).toFixed(0)}%`;
    const cleanSymbol = escapeHtml(position.symbol);

    const text = `
📉 <b>Confirm Paper Sell Order (${pctLabel})</b>

• <b>Token:</b> ${cleanSymbol} (${position.chain.toUpperCase()})
• <b>Selling Quantity:</b> <code>${formatQuantity(preview.quantityToSell)} ${cleanSymbol}</code>
• <b>Quoted Price:</b> <code>${formatPrice(preview.quotedPriceUsd)}</code>
• <b>Simulated Fill Price:</b> <code>${formatPrice(preview.executedPriceUsd)}</code>
• <b>Estimated Net Proceeds:</b> <code>${formatUsd(preview.netProceedsUsd)}</code>
• <b>Allocated Cost Basis:</b> <code>${formatUsd(preview.allocatedCostBasisUsd)}</code>
• <b>Estimated Realised P&amp;L:</b> <b>${formatUsd(preview.estimatedRealisedPnlUsd, true)} (${formatPercent(preview.estimatedReturnPercent, true)})</b>
${preview.simulatedCosts ? `• <b>Simulated Fee:</b> <code>${formatUsd(preview.feeUsd)}</code> | <b>Slippage:</b> <code>${preview.slippagePercent}%</code>` : ''}

<i>Quote valid for 30 seconds.</i>
`.trim();

    const kb = new InlineKeyboard()
      .text('✅ Confirm Sell', `cs:${preview.intentId}`)
      .text('❌ Cancel', 'cx');

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Sell Preview Error:</b>\n${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
  }
}

async function handleConfirmSell(ctx: any, intentId: string) {
  const telegramId = ctx.from.id;
  await ctx.reply('⏳ Executing paper sell transaction...');

  try {
    const { fill, position, newCashBalance, realisedPnlUsd, isFullClosure } = await paperTrading.confirmSell({
      intentId,
      telegramId,
    });

    const cleanSymbol = escapeHtml(fill.symbol);
    const pnlFormatted = formatUsd(realisedPnlUsd, true);

    const receipt = `
🎉 <b>Paper Sell Executed Successfully!</b>

• <b>Token:</b> ${cleanSymbol} (${fill.chain.toUpperCase()})
• <b>Sold Quantity:</b> <code>${formatQuantity(fill.quantity)} ${cleanSymbol}</code>
• <b>Execution Price:</b> <code>${formatPrice(fill.executedPriceUsd)}</code>
• <b>Net Cash Credited:</b> <code>${formatUsd(fill.cashDebitOrCredit)}</code>
• <b>Realised P&amp;L from Sale:</b> <b>${pnlFormatted}</b>
• <b>New Cash Balance:</b> <code>${formatUsd(newCashBalance)}</code>
• <b>Position Status:</b> ${isFullClosure ? 'CLOSED (100% sold)' : `OPEN (Remaining: ${formatQuantity(position.remainingQuantity)} ${cleanSymbol})`}
`.trim();

    const kb = new InlineKeyboard()
      .text('🖼️ Share P&L Card', `card:${position.positionId}`)
      .text('📊 Positions', 'm:pos')
      .row()
      .text('🔙 Main Menu', 'm:menu');

    await ctx.reply(receipt, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Sell Execution Failed:</b>\n${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
  }
}

async function handleSharePnlCard(ctx: any, positionId: string) {
  const telegramId = ctx.from.id;
  await ctx.reply('🎨 Rendering your high-resolution 1200x675 P&L Card...');

  try {
    const user = await storage.getUser(telegramId);
    const session = await storage.getActiveSession(telegramId);
    const position = await storage.getPosition(positionId);

    if (!user || !session || !position) {
      throw new Error('Position or user session not found.');
    }

    const valuation = await paperTrading.valuePosition(position, user.settings);
    const isClosed = position.status === 'closed';
    const isPartiallyClosed = !isClosed && D(position.totalQuantitySold).gt(0);

    const cardScope = isClosed ? 'closed' : isPartiallyClosed ? 'partially_closed' : 'open';
    const pnlUsd = isClosed ? position.totalRealisedPnl : valuation.unrealisedPnlUsd;
    const pnlPercent = isClosed
      ? D(position.totalRealisedPnl).dividedBy(D(position.totalCostBasisBought)).times(100).toString()
      : valuation.unrealisedPnlPercent;

    const currentOrExit = isClosed
      ? D(position.totalRealisedProceeds).dividedBy(D(position.totalQuantitySold)).toString()
      : valuation.currentPriceUsd;

    const cardId = `card_${telegramId}_${Date.now()}`;
    const cardSnapshot: PnlCardSnapshot = {
      cardId,
      telegramId,
      sessionId: session.sessionId,
      positionId,
      tokenName: position.tokenName,
      tokenSymbol: position.symbol,
      chain: position.chain,
      cardScope,
      pnlUsd,
      pnlPercent,
      entryPriceUsd: position.averageEntryPrice,
      currentOrExitPriceUsd: currentOrExit,
      investedCostBasisUsd: isClosed ? position.totalCostBasisBought : position.remainingCostBasis,
      realisedPnlUsd: isPartiallyClosed ? position.totalRealisedPnl : undefined,
      unrealisedPnlUsd: isPartiallyClosed ? valuation.unrealisedPnlUsd : undefined,
      snapshotTimestamp: Date.now(),
      displayName: user.settings.showDisplayName ? (user.settings.displayName || ctx.from.first_name) : undefined,
      theme: user.settings.cardTheme || 'pepe',
      imageUrl: position.imageUrl,
    };

    // Save exact snapshot
    await storage.saveCardSnapshot(cardSnapshot);

    // Render PNG Buffer
    const pngBuffer = await cardRenderer.renderPng(cardSnapshot);

    // Send Photo to Telegram chat
    const caption = `
🖼️ <b>DJN Paper Trader • P&L Snapshot</b>
${escapeHtml(position.symbol)} (${position.chain.toUpperCase()}) • <b>${formatPercent(pnlPercent, true)}</b> (${formatUsd(pnlUsd, true)})
<i>PAPER TRADE • SIMULATED FUNDS</i>
    `.trim();

    // Send as Telegram photo (grammY InputFile)
    const { InputFile } = await import('grammy');
    await ctx.replyWithPhoto(new InputFile(pngBuffer, `${cardSnapshot.tokenSymbol}_pnl.png`), {
      caption,
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Card Generation Error:</b>\n${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
      reply_markup: getMainMenuKeyboard(),
    });
  }
}

async function handleBalanceView(ctx: any, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  const session = await storage.getActiveSession(telegramId);
  const user = await storage.getUser(telegramId);
  if (!session || !user) return;

  const openPositions = await storage.getOpenPositions(telegramId, session.sessionId);
  let openValue = D(0);
  for (const p of openPositions) {
    const val = await paperTrading.valuePosition(p, user.settings);
    openValue = openValue.plus(D(val.markedMarketValueUsd));
  }

  const cash = D(session.cashBalance);
  const totalEquity = cash.plus(openValue);

  const text = `
💰 <b>Portfolio Balance Summary</b>

• <b>Available Cash:</b> <code>${formatUsd(session.cashBalance)}</code>
• <b>Open Positions Value:</b> <code>${formatUsd(openValue.toString())}</code>
• <b>Total Account Equity:</b> <b>${formatUsd(totalEquity.toString())}</b>
• <b>Starting Balance:</b> <code>${formatUsd(session.startingBalance)}</code>
• <b>Active Positions:</b> ${openPositions.length}

📌 <i>All funds are virtual credits for paper trading practice.</i>
`.trim();

  const kb = new InlineKeyboard()
    .text('📊 Positions', 'm:pos')
    .text('📈 Performance', 'm:perf')
    .row()
    .text('🔙 Main Menu', 'm:menu');

  if (isEdit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handleHistoryView(ctx: any, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  const session = await storage.getActiveSession(telegramId);
  if (!session) return;

  const history = await storage.getTradeHistory(telegramId, session.sessionId, 10);
  if (history.length === 0) {
    const text = '📜 <b>Trade History:</b> No recorded fills yet in this session.';
    const kb = new InlineKeyboard().text('🔙 Main Menu', 'm:menu');
    if (isEdit) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  let text = `📜 <b>Recent Trade History (Last ${history.length})</b>\n\n`;
  for (const fill of history) {
    const timeStr = new Date(fill.timestamp).toISOString().replace('T', ' ').substring(5, 16);
    const sideEmoji = fill.side === 'buy' ? '🟢 BUY' : '🔴 SELL';
    text += `${sideEmoji} <b>${escapeHtml(fill.symbol)}</b> (${fill.chain.toUpperCase()})\n`;
    text += `• Price: <code>${formatPrice(fill.executedPriceUsd)}</code> | Qty: <code>${formatQuantity(fill.quantity)}</code>\n`;
    text += `• Cash: <code>${formatUsd(fill.cashDebitOrCredit)}</code> | Time: <code>${timeStr}</code>\n\n`;
  }

  const kb = new InlineKeyboard().text('🔙 Main Menu', 'm:menu');
  if (isEdit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handlePerformanceView(ctx: any, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  try {
    const stats = await paperTrading.getPerformanceStats(telegramId);

    const winRate = `${parseFloat(stats.winRatePercent).toFixed(1)}%`;
    const bestTradeStr = stats.bestTrade
      ? `${stats.bestTrade.symbol} (+${formatUsd(stats.bestTrade.realisedPnlUsd)}, +${parseFloat(stats.bestTrade.returnPercent).toFixed(1)}%)`
      : 'None';
    const worstTradeStr = stats.worstTrade
      ? `${stats.worstTrade.symbol} (${formatUsd(stats.worstTrade.realisedPnlUsd)}, ${parseFloat(stats.worstTrade.returnPercent).toFixed(1)}%)`
      : 'None';

    const text = `
📈 <b>Trading Performance &amp; Analytics</b>

• <b>Starting Balance:</b> <code>${formatUsd(stats.startingBalance)}</code>
• <b>Available Cash:</b> <code>${formatUsd(stats.cashBalance)}</code>
• <b>Open Position Value:</b> <code>${formatUsd(stats.openPositionsValueUsd)}</code>
• <b>Account Equity:</b> <b>${formatUsd(stats.totalAccountEquityUsd)}</b> ${stats.isEquityIncomplete ? '⚠️ (Equity marked incomplete due to missing quotes)' : ''}

• <b>Total Realised P&amp;L:</b> <code>${formatUsd(stats.totalRealisedPnlUsd, true)}</code>
• <b>Total Unrealised P&amp;L:</b> <code>${formatUsd(stats.totalUnrealisedPnlUsd, true)}</code>

📊 <b>Trade Statistics:</b>
• Completed Positions: <code>${stats.completedPositionsCount}</code>
• Winning: <code>${stats.winningTradesCount}</code> | Losing: <code>${stats.losingTradesCount}</code> | Break-even: <code>${stats.breakEvenTradesCount}</code>
• <b>Win Rate:</b> <b>${winRate}</b> <i>(break-even trades treated neutrally)</i>
• <b>Best Trade:</b> ${escapeHtml(bestTradeStr)}
• <b>Worst Trade:</b> ${escapeHtml(worstTradeStr)}
`.trim();

    const kb = new InlineKeyboard().text('🔄 Refresh', 'm:perf').text('🔙 Main Menu', 'm:menu');

    if (isEdit) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  } catch (err: any) {
    await ctx.reply(`❌ <b>Performance Error:</b> ${escapeHtml(err.message)}`, { reply_markup: getMainMenuKeyboard() });
  }
}

async function handleSettingsView(ctx: any, isEdit: boolean = false) {
  const telegramId = ctx.from.id;
  const user = await storage.getUser(telegramId);
  if (!user) return;

  const modeStr = user.settings.simulatedCosts ? 'SIMULATED COSTS (fees & slippage)' : 'SIMPLE (zero fees)';
  const themeStr = user.settings.cardTheme.toUpperCase();

  const text = `
⚙️ <b>Settings &amp; Preferences</b>

• <b>Default Chain:</b> ${user.settings.defaultChain.toUpperCase()}
• <b>Practice Mode:</b> <b>${modeStr}</b>
• <b>P&amp;L Card Theme:</b> <b>${themeStr}</b>
• <b>Display Name:</b> ${user.settings.displayName || 'Trader'} (${user.settings.showDisplayName ? 'Visible' : 'Hidden'})

Choose an option below:
`.trim();

  const kb = new InlineKeyboard()
    .text(user.settings.simulatedCosts ? '⚡ Switch to Simple Mode' : '🛡️ Switch to Simulated Costs', 'set:mode')
    .row()
    .text('🐸 Theme: Pepe', 'theme:pepe')
    .text('🐕 Doge', 'theme:doge')
    .text('🐂 Chad', 'theme:chad')
    .row()
    .text('🔄 Reset Practice Account ($1,000)', 'rst:ask')
    .row()
    .text('🔙 Main Menu', 'm:menu');

  if (isEdit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handleHelpView(ctx: any, isEdit: boolean = false) {
  const text = `
ℹ️ <b>DJN Paper Trader Help &amp; Guide</b>

<b>How to trade:</b>
1. Paste any memecoin contract address from <b>Solana, Base, Ethereum, or BSC</b>, or paste a <b>DEX Screener pair link</b>.
2. Inspect live prices, liquidity, and 24h market metrics.
3. Click <b>Buy $25 / $50 / $100</b> to preview and confirm simulated fills.
4. Go to <b>Positions</b> to monitor real-time P&L movements and sell 25%, 50%, or 100%.
5. Click <b>Share P&amp;L</b> to generate a 1200x675 meme card snapshot to download or forward to your friends.

<b>Commands:</b>
/start - Open bot and verify starting balance
/buy - Paste token address to buy
/positions - View open positions and sell
/balance - Portfolio balance and cash equity
/history - Recent trade fills
/performance - Win-rate, total P&L, best/worst trades
/settings - Toggle fees/slippage, change themes or reset
/help - This guide

<b>Rules &amp; Boundaries:</b>
• 100% simulated paper trading funds.
• No wallet connections, deposits, or private keys.
• Real-time pricing sourced directly from DEX Screener.
`.trim();

  const kb = new InlineKeyboard().text('🔎 Buy / Find Token', 'm:find').text('🔙 Main Menu', 'm:menu');

  if (isEdit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// Global error handler to catch handler errors and keep the bot connection running smoothly
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Telegram Bot] Error while handling update ${ctx?.update?.update_id}:`, err.error);
  try {
    ctx.reply('⚠️ An unexpected error occurred while processing this action. Please try again.').catch(() => {});
  } catch {}
});
