/**
 * @file server/config.ts
 * Server-side runtime configuration and environment variable loading
 */

import dotenv from 'dotenv';
dotenv.config();

export interface ServerConfig {
  port: number;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  publicBaseUrl: string;
  useWebhook: boolean;
  adminApiKey: string;
  gcpProjectId?: string;
  firestoreDatabaseId: string;
  firestoreEmulatorHost?: string;
  quoteExpiryMs: number;
  materialPriceChangeThresholdPercent: number;
}

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'http://localhost:3000',
  useWebhook: process.env.USE_WEBHOOK === 'true' || Boolean(process.env.TELEGRAM_WEBHOOK_URL),
  adminApiKey: process.env.ADMIN_API_KEY || 'default_admin_secret',
  gcpProjectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || undefined,
  firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
  firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST || undefined,
  quoteExpiryMs: 30000, // 30 seconds
  materialPriceChangeThresholdPercent: 15.0, // 15% price deviation allowance for volatile memecoins
};

/**
 * Returns true if the Telegram bot token is configured
 */
export function isBotConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramBotToken.length > 10);
}
