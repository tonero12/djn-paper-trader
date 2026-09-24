/**
 * @file server.ts
 * Express + Telegram Webhook + Card Image Server + Vite Dev/Prod integration
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const execAsync = promisify(exec);
import { bot } from './server/bot/bot.js';
import { config, isBotConfigured } from './server/config.js';
import { storage } from './server/storage/firestore.js';
import { cardRenderer } from './server/services/cardRenderer.js';
import { requireAdminKey, verifyTelegramWebhook } from './server/utils/security.js';
import { paperTrading } from './server/services/trading.js';
import { dexScreener } from './server/dexscreener/adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Polling state tracking
  let isPollingActive = false;
  let pollingConflictDetected = false;
  let lastPollingError: string | null = null;
  let pausePolling = false;

  // Standard middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ==========================================
  // Health & Public Status
  // ==========================================
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'DJN Paper Trader',
      timestamp: Date.now(),
      botConfigured: isBotConfigured(),
      storage: storage.getStorageType(),
    });
  });

  app.get('/api/status', async (req: Request, res: Response) => {
    let webhookInfo: any = null;
    let botInfo: any = null;
    if (isBotConfigured()) {
      try {
        webhookInfo = await bot.api.getWebhookInfo();
        botInfo = await bot.api.getMe();
      } catch (err: any) {
        webhookInfo = { error: err.message };
      }
    }

    res.json({
      status: 'active',
      appName: 'DJN Paper Trader',
      botConfigured: isBotConfigured(),
      botInfo,
      publicBaseUrl: config.publicBaseUrl,
      webhookPath: '/api/telegram/webhook',
      expectedWebhookUrl: `${config.publicBaseUrl}/api/telegram/webhook`,
      telegramWebhookInfo: webhookInfo,
      storage: {
        type: storage.getStorageType(),
        gcpProject: config.gcpProjectId || 'none',
        databaseId: config.firestoreDatabaseId,
      },
      pollingStatus: {
        isActive: isPollingActive,
        conflictDetected: pollingConflictDetected,
        isPaused: pausePolling,
        lastError: lastPollingError,
      },
      quoteExpiryMs: config.quoteExpiryMs,
      materialPriceChangeThresholdPercent: config.materialPriceChangeThresholdPercent,
    });
  });

  app.post('/api/bot/pause-polling', async (req: Request, res: Response) => {
    pausePolling = true;
    try {
      await bot.stop();
    } catch {}
    isPollingActive = false;
    res.json({ success: true, message: 'Local bot polling paused. Live cloud instance can run without 409 conflict.' });
  });

  app.post('/api/bot/resume-polling', (req: Request, res: Response) => {
    pausePolling = false;
    pollingConflictDetected = false;
    lastPollingError = null;
    res.json({ success: true, message: 'Local bot polling resumed.' });
  });

  // ==========================================
  // Telegram HTTPS Webhook Ingress
  // ==========================================
  app.post('/api/telegram/webhook', verifyTelegramWebhook, async (req: Request, res: Response) => {
    try {
      if (!isBotConfigured()) {
        console.warn('[Webhook] Telegram bot token is not configured yet. Update received was ignored.');
        res.status(200).send('Bot token not configured');
        return;
      }

      // Pass update directly to grammY bot
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } catch (err) {
      console.error('[Webhook] Error handling telegram update:', err);
      // Always return 200 to prevent Telegram from looping retries indefinitely on unrecoverable app exceptions
      res.status(200).send('Error handled');
    }
  });

  // ==========================================
  // Rendered P&L Card Image Endpoint
  // ==========================================
  app.get('/api/cards/:cardId.png', async (req: Request, res: Response) => {
    try {
      const cardId = req.params.cardId;
      const snapshot = await storage.getCardSnapshot(cardId);
      if (!snapshot) {
        res.status(404).send('Card snapshot not found');
        return;
      }

      const pngBuffer = await cardRenderer.renderPng(snapshot);
      res.set({
        'Content-Type': 'image/png',
        'Content-Length': pngBuffer.length,
        'Cache-Control': 'public, max-age=86400', // Immutable snapshot cached
      });
      res.send(pngBuffer);
    } catch (err) {
      console.error('[Card API] Error rendering card:', err);
      res.status(500).send('Failed to render card');
    }
  });

  // ==========================================
  // Protected Admin Management Endpoints
  // ==========================================
  app.post('/api/admin/set-webhook', requireAdminKey, async (req: Request, res: Response) => {
    if (!isBotConfigured()) {
      res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' });
      return;
    }

    try {
      const webhookUrl = `${config.publicBaseUrl}/api/telegram/webhook`;
      const options: any = {
        drop_pending_updates: req.body.drop_pending_updates || false,
      };

      if (config.telegramWebhookSecret) {
        options.secret_token = config.telegramWebhookSecret;
      }

      await bot.api.setWebhook(webhookUrl, options);
      const info = await bot.api.getWebhookInfo();

      res.json({
        success: true,
        message: `Webhook registered at ${webhookUrl}`,
        webhookInfo: info,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/set-polling', requireAdminKey, async (req: Request, res: Response) => {
    if (!isBotConfigured()) {
      res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' });
      return;
    }

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      const info = await bot.api.getWebhookInfo();

      res.json({
        success: true,
        message: 'Webhook removed. Long polling mode is enabled.',
        webhookInfo: info,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/set-commands', requireAdminKey, async (req: Request, res: Response) => {
    if (!isBotConfigured()) {
      res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' });
      return;
    }

    try {
      await bot.api.setMyCommands([
        { command: 'start', description: 'Create account and get $1,000 practice funds' },
        { command: 'buy', description: 'Look up token contract and buy' },
        { command: 'positions', description: 'View open positions and sell' },
        { command: 'sell', description: 'Quick sell open positions' },
        { command: 'pnl', description: 'Generate high-res P&L card' },
        { command: 'portfolio', description: 'View portfolio and active trades' },
        { command: 'balance', description: 'Check virtual cash and equity' },
        { command: 'history', description: 'Review past fills' },
        { command: 'performance', description: 'View win rate and P&L analytics' },
        { command: 'settings', description: 'Configure fees, slippage & card themes' },
        { command: 'help', description: 'Guide and documentation' },
      ]);

      res.json({ success: true, message: 'Bot commands registered successfully.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // Web Preview Simulator API
  // (Provides an interactive testing playground right in the web preview!)
  // ==========================================
  app.post('/api/simulator/action', async (req: Request, res: Response) => {
    try {
      const { telegramId = 999999, action, payload } = req.body;
      const { user, session } = await storage.getOrCreateUser(telegramId, 'Demo Trader');

      if (action === 'get_overview') {
        const positions = await storage.getOpenPositions(telegramId, session.sessionId);
        const history = await storage.getTradeHistory(telegramId, session.sessionId, 10);
        const stats = await paperTrading.getPerformanceStats(telegramId);
        res.json({ user, session, positions, history, stats });
        return;
      }

      if (action === 'quote') {
        const { address, chain = 'solana' } = payload;
        const quote = await dexScreener.getTokenQuote(address, chain);
        res.json({ quote });
        return;
      }

      if (action === 'buy_preview') {
        const { address, chain = 'solana', spendAmount } = payload;
        const result = await paperTrading.prepareBuyPreview({
          telegramId,
          sessionId: session.sessionId,
          tokenAddress: address,
          chain,
          spendAmountUsd: spendAmount,
          userSettings: user.settings,
        });
        res.json(result);
        return;
      }

      if (action === 'confirm_buy') {
        const { intentId } = payload;
        const result = await paperTrading.confirmBuy({ intentId, telegramId });
        res.json(result);
        return;
      }

      if (action === 'sell_preview') {
        const { positionId, sellFraction } = payload;
        const result = await paperTrading.prepareSellPreview({
          telegramId,
          positionId,
          sellFraction,
          userSettings: user.settings,
        });
        res.json(result);
        return;
      }

      if (action === 'confirm_sell') {
        const { intentId } = payload;
        const result = await paperTrading.confirmSell({ intentId, telegramId });
        res.json(result);
        return;
      }

      if (action === 'reset_account') {
        const result = await storage.resetAccountSession(telegramId);
        res.json(result);
        return;
      }

      res.status(400).json({ error: 'Unknown simulator action' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ==========================================
  // Git & Project Export Endpoints
  // ==========================================
  app.get('/api/git/info', async (req: Request, res: Response) => {
    try {
      let branch = 'main';
      let totalCommits = 0;
      let latestCommit = { hash: '', author: '', message: '', date: '' };
      let remoteUrl = '';

      try {
        const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD');
        branch = branchOut.trim();
      } catch {}

      try {
        const { stdout: countOut } = await execAsync('git rev-list --count HEAD');
        totalCommits = parseInt(countOut.trim(), 10) || 0;
      } catch {}

      try {
        const { stdout: logOut } = await execAsync('git log -1 --pretty=format:"%h|%an|%s|%cd"');
        const parts = logOut.trim().split('|');
        if (parts.length >= 4) {
          latestCommit = {
            hash: parts[0],
            author: parts[1],
            message: parts[2],
            date: parts[3],
          };
        }
      } catch {}

      try {
        const { stdout: remOut } = await execAsync('git remote get-url origin');
        remoteUrl = remOut.trim();
      } catch {}

      res.json({
        initialized: true,
        branch,
        totalCommits,
        latestCommit,
        remoteUrl: remoteUrl.replace(/https:\/\/[^@]+@/g, 'https://***@'),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/git/download', async (req: Request, res: Response) => {
    try {
      const zipPath = path.join('/tmp', `djn-paper-trader-${Date.now()}.zip`);
      await execAsync(`git archive --format=zip -o "${zipPath}" HEAD`);
      res.download(zipPath, 'djn-paper-trader.zip', (err) => {
        try {
          if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
          }
        } catch {}
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create export zip: ' + err.message });
    }
  });

  app.post('/api/git/push', async (req: Request, res: Response) => {
    try {
      const { repoUrl, token, branch = 'main', force = false } = req.body;
      if (!repoUrl || typeof repoUrl !== 'string') {
        res.status(400).json({ error: 'GitHub repository URL is required (e.g. https://github.com/username/repo.git)' });
        return;
      }

      let targetUrl = repoUrl.trim();
      if (token && typeof token === 'string' && token.trim()) {
        const cleanToken = token.trim();
        if (targetUrl.startsWith('https://')) {
          const withoutProto = targetUrl.replace('https://', '');
          const cleanHostAndPath = withoutProto.includes('@') ? withoutProto.split('@')[1] : withoutProto;
          targetUrl = `https://${encodeURIComponent(cleanToken)}@${cleanHostAndPath}`;
        }
      }

      try {
        await execAsync('git remote remove origin');
      } catch {}

      await execAsync(`git remote add origin "${targetUrl}"`);

      const forceArg = force ? ' --force' : '';
      const { stdout, stderr } = await execAsync(`git push -u origin ${branch}${forceArg}`);
      const combined = (stdout + '\n' + stderr).replace(/https:\/\/[^@]+@/g, 'https://***@');

      res.json({
        success: true,
        message: 'Successfully pushed code to GitHub!',
        output: combined,
      });
    } catch (err: any) {
      const safeError = (err?.message || String(err)).replace(/https:\/\/[^@]+@/g, 'https://***@');
      res.status(500).json({ error: safeError });
    }
  });

  // ==========================================
  // Vite Integration (Dev) / Static Files (Prod)
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[DJN Paper Trader] Server running on http://0.0.0.0:${PORT}`);
    console.log(`[DJN Paper Trader] Bot configured: ${isBotConfigured()}`);
    console.log(`[DJN Paper Trader] Storage: ${storage.getStorageType()}`);

    if (isBotConfigured()) {
      try {
        // Auto-register standard commands
        try {
          await bot.api.setMyCommands([
            { command: 'start', description: 'Create account and get $1,000 practice funds' },
            { command: 'buy', description: 'Look up token contract and buy' },
            { command: 'positions', description: 'View open positions and sell' },
            { command: 'sell', description: 'Quick sell open positions' },
            { command: 'pnl', description: 'Generate high-res P&L card' },
            { command: 'portfolio', description: 'View portfolio and active trades' },
            { command: 'balance', description: 'Check virtual cash and equity' },
            { command: 'history', description: 'Review past fills' },
            { command: 'performance', description: 'View win rate and P&L analytics' },
            { command: 'settings', description: 'Configure fees, slippage & card themes' },
            { command: 'help', description: 'Guide and documentation' },
          ]);
        } catch (cmdErr: any) {
          console.warn('[DJN Paper Trader] Notice: Could not set bot commands automatically:', cmdErr.message);
        }

        if (config.useWebhook) {
          const webhookUrl = `${config.publicBaseUrl}/api/telegram/webhook`;
          console.log(`[DJN Paper Trader] Webhook mode activated. Registering webhook at ${webhookUrl}...`);
          const options: any = { drop_pending_updates: false };
          if (config.telegramWebhookSecret) {
            options.secret_token = config.telegramWebhookSecret;
          }
          await bot.api.setWebhook(webhookUrl, options);
          console.log(`[DJN Paper Trader] ✅ Telegram webhook actively listening at ${webhookUrl}`);
        } else {
          // Automatically delete any webhook so long polling connects immediately
          await bot.api.deleteWebhook({ drop_pending_updates: false });
          console.log('[DJN Paper Trader] Webhook cleaned. Starting direct Telegram bot polling with auto-reconnect...');

          // Supervisor loop: auto-reconnects if Telegram drops the connection or socket resets
          let reconnectDelay = 2000;
          const runPollingSupervisor = async () => {
            while (true) {
              if (pausePolling) {
                isPollingActive = false;
                await new Promise((resolve) => setTimeout(resolve, 5000));
                continue;
              }

              try {
                console.log('[DJN Paper Trader] Connecting to Telegram long polling stream...');
                isPollingActive = true;
                pollingConflictDetected = false;
                lastPollingError = null;

                try {
                  await bot.stop();
                } catch {}

                await bot.start({
                  drop_pending_updates: false,
                  allowed_updates: ['message', 'callback_query'],
                  onStart: (botInfo) => {
                    reconnectDelay = 2000;
                    isPollingActive = true;
                    pollingConflictDetected = false;
                    lastPollingError = null;
                    console.log(`[DJN Paper Trader] ✅ Telegram bot @${botInfo.username} (ID: ${botInfo.id}) is actively listening!`);
                  },
                });
              } catch (err: any) {
                isPollingActive = false;
                const errStr = String(err?.message || err);
                const isConflict = errStr.includes('409') || errStr.includes('Conflict');

                if (isConflict) {
                  pollingConflictDetected = true;
                  lastPollingError = 'Telegram 409 Conflict: Resetting connection stream...';
                  console.warn(`[DJN Paper Trader] Telegram update conflict/reset detected. Clearing runner and retrying in 3s...`);
                  try {
                    await bot.stop();
                  } catch {}
                  await new Promise((resolve) => setTimeout(resolve, 3000));
                } else {
                  lastPollingError = errStr;
                  console.error(`[DJN Paper Trader] Telegram bot connection dropped: ${errStr}. Reconnecting in ${reconnectDelay / 1000}s...`);
                  try {
                    await bot.stop();
                  } catch {}
                  await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
                  reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
                }
              }
            }
          };

          runPollingSupervisor().catch((err) => {
            console.error('[DJN Paper Trader] Polling supervisor error:', err);
          });
        }
      } catch (err: any) {
        console.error('[DJN Paper Trader] Failed to initialize Telegram bot:', err.message);
      }
    } else {
      console.log('[DJN Paper Trader] Notice: TELEGRAM_BOT_TOKEN is not set yet. The bot will automatically start polling once TELEGRAM_BOT_TOKEN is provided in .env.');
    }
  });
}

startServer();
