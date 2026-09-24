/**
 * @file server/utils/security.ts
 * Security utilities: webhook verification, admin authorization, string escaping & SSRF guard
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/**
 * Escapes characters for Telegram HTML parse mode: <, >, &
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes XML/SVG special characters
 */
export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Middleware: Verify Telegram Webhook Secret Token
 */
export function verifyTelegramWebhook(req: Request, res: Response, next: NextFunction): void {
  // If no secret configured, allow (development fallback with warning)
  if (!config.telegramWebhookSecret) {
    next();
    return;
  }

  const headerSecret = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!headerSecret || headerSecret !== config.telegramWebhookSecret) {
    res.status(403).json({ error: 'Unauthorized webhook request' });
    return;
  }

  next();
}

/**
 * Middleware: Require Admin API Key for administrative endpoints
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header('Authorization');
  const keyHeader = req.header('X-Admin-Key');
  
  let suppliedKey = '';
  if (keyHeader) {
    suppliedKey = keyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    suppliedKey = authHeader.substring(7).trim();
  }

  if (!suppliedKey || suppliedKey !== config.adminApiKey) {
    res.status(401).json({ error: 'Unauthorized. Admin API key required.' });
    return;
  }

  next();
}

/**
 * Validates external image URL to prevent SSRF and private-network queries
 */
export function isSafeImageUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    // Must be https:
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();
    
    // Disallow localhost, loopback, private ranges
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.')
    ) {
      return false;
    }

    // Disallow 172.16.0.0 – 172.31.255.255
    const match172 = hostname.match(/^172\.(\d+)\./);
    if (match172) {
      const secondOctet = parseInt(match172[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) return false;
    }

    return true;
  } catch {
    return false;
  }
}
