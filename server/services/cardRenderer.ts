/**
 * @file server/services/cardRenderer.ts
 * Server-side high-resolution 1200x675 SVG and PNG P&L card generator
 */

import sharp from 'sharp';
import { PnlCardSnapshot, SupportedChain } from '../types.js';
import { escapeXml, isSafeImageUrl } from '../utils/security.js';
import { D, formatPercent, formatPrice, formatUsd } from '../utils/decimal.js';
import { FONT_SANS_BOLD_BASE64, FONT_SANS_REGULAR_BASE64 } from '../assets/fontBase64.js';

export interface GenerateCardParams {
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
  displayName?: string;
  theme?: 'pepe' | 'doge' | 'chad';
  imageUrl?: string;
}

export class CardRenderer {
  /**
   * Generates a 1200x675 PNG buffer of the P&L card snapshot
   */
  public async renderPng(snapshot: PnlCardSnapshot): Promise<Buffer> {
    const svg = await this.generateSvg(snapshot);
    const pngBuffer = await sharp(Buffer.from(svg))
      .resize(1200, 675)
      .png({ quality: 95 })
      .toBuffer();
    return pngBuffer;
  }

  /**
   * Generates valid SVG markup
   */
  public async generateSvg(snapshot: PnlCardSnapshot): Promise<string> {
    const pnl = D(snapshot.pnlUsd);
    const isGain = pnl.gt(0);
    const isLoss = pnl.lt(0);

    const accentColor = isGain ? '#10B981' : isLoss ? '#EF4444' : '#94A3B8';
    const accentBgGlow = isGain ? 'rgba(16, 185, 129, 0.12)' : isLoss ? 'rgba(239, 68, 68, 0.12)' : 'rgba(148, 163, 184, 0.1)';
    const statusText = snapshot.cardScope === 'open' ? 'OPEN POSITION' : snapshot.cardScope === 'partially_closed' ? 'PARTIALLY CLOSED' : 'CLOSED TRADE';

    const cleanSymbol = escapeXml(snapshot.tokenSymbol.toUpperCase());
    const cleanName = escapeXml(snapshot.tokenName.length > 24 ? snapshot.tokenName.substring(0, 24) + '...' : snapshot.tokenName);
    const cleanChain = escapeXml(snapshot.chain.toUpperCase());
    const cleanDisplayName = snapshot.displayName ? escapeXml(snapshot.displayName) : 'Trader';
    const dateFormatted = new Date(snapshot.snapshotTimestamp).toUTCString().replace('GMT', 'UTC');

    const formattedPnlUsd = formatUsd(pnl, true);
    const formattedPnlPercent = formatPercent(snapshot.pnlPercent, true);

    const memeSvg = this.getMemeIllustration(snapshot.theme || 'pepe', isGain, isLoss);

    // If partial closure, prepare secondary metrics
    let partialMetricsSvg = '';
    if (snapshot.cardScope === 'partially_closed') {
      const realised = snapshot.realisedPnlUsd ? formatUsd(snapshot.realisedPnlUsd, true) : '$0.00';
      const unrealised = snapshot.unrealisedPnlUsd ? formatUsd(snapshot.unrealisedPnlUsd, true) : '$0.00';
      partialMetricsSvg = `
        <g transform="translate(80, 480)">
          <rect width="500" height="50" rx="8" fill="#1A1F26" />
          <text x="20" y="32" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="14" font-weight="600" fill="#94A3B8">REALISED P&amp;L: <tspan fill="#F8FAFC">${realised}</tspan></text>
          <text x="260" y="32" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="14" font-weight="600" fill="#94A3B8">UNREALISED: <tspan fill="${accentColor}">${unrealised}</tspan></text>
        </g>
      `;
    }

    const priceLabel = snapshot.cardScope === 'closed' ? 'Avg Exit Price' : 'Current Price';

    return `
<svg width="1200" height="675" viewBox="0 0 1200 675" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_REGULAR_BASE64}') format('truetype');
        font-weight: 400;
        font-style: normal;
      }
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_REGULAR_BASE64}') format('truetype');
        font-weight: 500;
        font-style: normal;
      }
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_REGULAR_BASE64}') format('truetype');
        font-weight: 600;
        font-style: normal;
      }
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_BOLD_BASE64}') format('truetype');
        font-weight: 700;
        font-style: normal;
      }
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_BOLD_BASE64}') format('truetype');
        font-weight: 800;
        font-style: normal;
      }
      @font-face {
        font-family: 'DJNSans';
        src: url('data:font/truetype;charset=utf-8;base64,${FONT_SANS_BOLD_BASE64}') format('truetype');
        font-weight: 900;
        font-style: normal;
      }
      text {
        font-family: 'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, Helvetica, sans-serif;
      }
    </style>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F1216" />
      <stop offset="100%" stop-color="#181D24" />
    </linearGradient>
    <linearGradient id="cardGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.25" />
      <stop offset="100%" stop-color="${accentColor}" stop-opacity="0.0" />
    </linearGradient>
    <radialGradient id="pnlGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.18" />
      <stop offset="100%" stop-color="${accentColor}" stop-opacity="0.0" />
    </radialGradient>
  </defs>

  <!-- Background Base -->
  <rect width="1200" height="675" fill="url(#bgGrad)" />

  <!-- Subtle Outer Border -->
  <rect x="20" y="20" width="1160" height="635" rx="24" fill="#14181F" stroke="#262D38" stroke-width="2" />

  <!-- Radial Glow behind Main P&L -->
  <circle cx="340" cy="310" r="280" fill="url(#pnlGlow)" />

  <!-- Top Header Bar -->
  <g transform="translate(60, 60)">
    <!-- App Brand -->
    <rect width="44" height="44" rx="10" fill="#2563EB" />
    <text x="12" y="30" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="20" font-weight="900" fill="#FFFFFF">DJN</text>
    <text x="58" y="25" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="20" font-weight="800" fill="#F8FAFC" letter-spacing="-0.5">DJN PAPER TRADER</text>
    <text x="58" y="42" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="12" font-weight="600" fill="#64748B">MEMECOIN SIMULATOR</text>

    <!-- Simulated Funds Warning Badge -->
    <rect x="730" y="4" width="350" height="36" rx="18" fill="#F59E0B" fill-opacity="0.15" stroke="#F59E0B" stroke-width="1.5" />
    <text x="905" y="27" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="12" font-weight="800" fill="#FBBF24" text-anchor="middle" letter-spacing="1">PAPER TRADE • SIMULATED FUNDS</text>
  </g>

  <!-- Token Identity & Chain Tag -->
  <g transform="translate(60, 140)">
    <rect width="80" height="28" rx="6" fill="#1E293B" />
    <text x="40" y="19" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="12" font-weight="700" fill="#38BDF8" text-anchor="middle">${cleanChain}</text>

    <!-- Status Badge -->
    <rect x="90" y="0" width="160" height="28" rx="6" fill="${accentBgGlow}" stroke="${accentColor}" stroke-width="1" />
    <text x="170" y="19" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="12" font-weight="800" fill="${accentColor}" text-anchor="middle">${statusText}</text>

    <text x="0" y="72" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="44" font-weight="900" fill="#FFFFFF" letter-spacing="-1">${cleanSymbol}</text>
    <text x="0" y="102" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="18" font-weight="500" fill="#94A3B8">${cleanName}</text>
  </g>

  <!-- Massive Headline P&L -->
  <g transform="translate(60, 310)">
    <text x="0" y="50" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="78" font-weight="900" fill="${accentColor}" letter-spacing="-2">
      ${formattedPnlPercent}
    </text>
    <text x="0" y="98" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="32" font-weight="800" fill="${accentColor}" opacity="0.9">
      ${formattedPnlUsd}
    </text>
  </g>

  <!-- Bottom Metric Grid -->
  <g transform="translate(60, 460)">
    <!-- Cost Basis -->
    <g transform="translate(0, 0)">
      <text x="0" y="0" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="13" font-weight="600" fill="#64748B" text-transform="uppercase" letter-spacing="0.5">Invested Cost Basis</text>
      <text x="0" y="26" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="20" font-weight="700" fill="#F1F5F9">${formatUsd(snapshot.investedCostBasisUsd)}</text>
    </g>

    <!-- Entry Price -->
    <g transform="translate(220, 0)">
      <text x="0" y="0" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="13" font-weight="600" fill="#64748B" text-transform="uppercase" letter-spacing="0.5">Entry Price</text>
      <text x="0" y="26" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="20" font-weight="700" fill="#F1F5F9">${formatPrice(snapshot.entryPriceUsd)}</text>
    </g>

    <!-- Current / Exit Price -->
    <g transform="translate(440, 0)">
      <text x="0" y="0" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="13" font-weight="600" fill="#64748B" text-transform="uppercase" letter-spacing="0.5">${priceLabel}</text>
      <text x="0" y="26" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="20" font-weight="700" fill="#F1F5F9">${formatPrice(snapshot.currentOrExitPriceUsd)}</text>
    </g>
  </g>

  ${partialMetricsSvg}

  <!-- Meme Illustration on Right Side -->
  <g transform="translate(760, 160)">
    ${memeSvg}
  </g>

  <!-- Footer Info -->
  <g transform="translate(60, 600)">
    <text x="0" y="0" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="13" font-weight="600" fill="#475569">
      Trader: <tspan fill="#94A3B8">${cleanDisplayName}</tspan> • Snapshot: <tspan fill="#94A3B8">${dateFormatted}</tspan>
    </text>
    <text x="1080" y="0" font-family="'DJNSans', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif" font-size="13" font-weight="700" fill="#475569" text-anchor="end">
      djn-paper-trader.run.app
    </text>
  </g>
</svg>
    `.trim();
  }

  /**
   * Bundled High Quality Meme SVG Artwork for Pepe, Doge, Chad
   */
  private getMemeIllustration(theme: 'pepe' | 'doge' | 'chad', isGain: boolean, isLoss: boolean): string {
    if (theme === 'doge') {
      // Doge Shiba Astronaut / Sunglasses Meme
      const eyeGlassColor = isGain ? '#10B981' : isLoss ? '#EF4444' : '#F59E0B';
      return `
      <g>
        <!-- Astronaut Helmet / Circle -->
        <circle cx="180" cy="180" r="160" fill="#1E2530" stroke="#334155" stroke-width="4" />
        <ellipse cx="180" cy="190" rx="140" ry="120" fill="#D97706" fill-opacity="0.15" />

        <!-- Shiba Inu Face -->
        <!-- Ears -->
        <polygon points="80,100 120,40 160,110" fill="#EAB308" stroke="#CA8A04" stroke-width="4" />
        <polygon points="95,95 120,55 145,100" fill="#FEF08A" />
        <polygon points="280,100 240,40 200,110" fill="#EAB308" stroke="#CA8A04" stroke-width="4" />
        <polygon points="265,95 240,55 215,100" fill="#FEF08A" />

        <!-- Head Contour -->
        <ellipse cx="180" cy="180" rx="100" ry="85" fill="#EAB308" />
        <ellipse cx="180" cy="205" rx="60" ry="45" fill="#FEF08A" />

        <!-- Muzzle / Nose -->
        <polygon points="170,195 190,195 180,205" fill="#1E293B" />
        <path d="M175,208 Q180,214 185,208" stroke="#1E293B" stroke-width="3" fill="none" />

        <!-- Sunglasses / Laser Eyes -->
        <rect x="110" y="150" width="60" height="30" rx="6" fill="#0F172A" stroke="${eyeGlassColor}" stroke-width="3" />
        <rect x="190" y="150" width="60" height="30" rx="6" fill="#0F172A" stroke="${eyeGlassColor}" stroke-width="3" />
        <line x1="170" y1="165" x2="190" y2="165" stroke="${eyeGlassColor}" stroke-width="4" />

        ${isGain ? `<line x1="140" y1="165" x2="-40" y2="140" stroke="#10B981" stroke-width="5" stroke-linecap="round" />
                    <line x1="220" y1="165" x2="-20" y2="155" stroke="#10B981" stroke-width="5" stroke-linecap="round" />` : ''}

        <!-- Badge / Text -->
        <rect x="100" y="290" width="160" height="32" rx="16" fill="#0F172A" stroke="#475569" stroke-width="2" />
        <text x="180" y="311" font-family="'DJNSans', 'Liberation Sans', sans-serif" font-size="13" font-weight="900" fill="#F8FAFC" text-anchor="middle">MUCH P&amp;L • DOGE</text>
      </g>
      `;
    }

    if (theme === 'chad') {
      // Giga Chad Bull silhouette with horns
      const glow = isGain ? '#10B981' : '#F43F5E';
      return `
      <g>
        <circle cx="180" cy="180" r="160" fill="#1A1F29" stroke="#334155" stroke-width="4" />
        
        <!-- Chad Bull Horns -->
        <path d="M70,140 Q40,60 120,40 Q100,80 110,120 Z" fill="#94A3B8" stroke="#64748B" stroke-width="2" />
        <path d="M290,140 Q320,60 240,40 Q260,80 250,120 Z" fill="#94A3B8" stroke="#64748B" stroke-width="2" />

        <!-- Jaw / Face Structure -->
        <polygon points="180,80 240,130 230,220 180,270 130,220 120,130" fill="#334155" stroke="#64748B" stroke-width="3" />
        <!-- Prominent Chad Chin -->
        <polygon points="160,250 200,250 190,275 170,275" fill="#475569" />

        <!-- Eyes / Shades -->
        <polygon points="135,150 170,150 165,168 140,168" fill="#0F172A" stroke="${glow}" stroke-width="3" />
        <polygon points="190,150 225,150 220,168 195,168" fill="#0F172A" stroke="${glow}" stroke-width="3" />

        <!-- Nose ring -->
        <circle cx="180" cy="215" r="16" fill="none" stroke="#F59E0B" stroke-width="5" />

        <rect x="90" y="295" width="180" height="32" rx="16" fill="#0F172A" stroke="#475569" stroke-width="2" />
        <text x="180" y="316" font-family="'DJNSans', 'Liberation Sans', sans-serif" font-size="13" font-weight="900" fill="#F8FAFC" text-anchor="middle">GIGA CHAD TRADER</text>
      </g>
      `;
    }

    // Default: Pepe The Frog Trader with Sunglasses & Headband
    const pepeHeadband = isGain ? '#10B981' : isLoss ? '#EF4444' : '#3B82F6';
    return `
    <g>
      <circle cx="180" cy="180" r="160" fill="#18202A" stroke="#334155" stroke-width="4" />
      
      <!-- Pepe Head Base -->
      <ellipse cx="180" cy="190" rx="115" ry="95" fill="#4ADE80" stroke="#166534" stroke-width="4" />
      
      <!-- Big Pepe Eyes (Frog Orbs) -->
      <ellipse cx="135" cy="120" rx="36" ry="40" fill="#4ADE80" stroke="#166534" stroke-width="3" />
      <ellipse cx="225" cy="120" rx="36" ry="40" fill="#4ADE80" stroke="#166534" stroke-width="3" />

      <!-- Headband -->
      <rect x="80" y="110" width="200" height="24" rx="6" fill="${pepeHeadband}" stroke="#0F172A" stroke-width="2" />
      <circle cx="180" cy="122" r="7" fill="#F8FAFC" />

      <!-- Sunglasses -->
      <rect x="105" y="130" width="65" height="42" rx="10" fill="#0B0F15" stroke="#1E293B" stroke-width="3" />
      <rect x="190" y="130" width="65" height="42" rx="10" fill="#0B0F15" stroke="#1E293B" stroke-width="3" />
      <line x1="170" y1="145" x2="190" y2="145" stroke="#0B0F15" stroke-width="6" />

      <!-- Pepe Lips / Expression -->
      <ellipse cx="180" cy="215" rx="75" ry="24" fill="#22C55E" stroke="#15803D" stroke-width="3" />
      ${isGain
        ? `<path d="M125,215 Q180,240 235,215" stroke="#14532D" stroke-width="5" fill="none" stroke-linecap="round" />`
        : isLoss
        ? `<path d="M125,225 Q180,195 235,225" stroke="#14532D" stroke-width="5" fill="none" stroke-linecap="round" />`
        : `<line x1="130" y1="218" x2="230" y2="218" stroke="#14532D" stroke-width="5" stroke-linecap="round" />`
      }

      <rect x="110" y="295" width="140" height="32" rx="16" fill="#0F172A" stroke="#475569" stroke-width="2" />
      <text x="180" y="316" font-family="'DJNSans', 'Liberation Sans', sans-serif" font-size="13" font-weight="900" fill="#F8FAFC" text-anchor="middle">PEPE HODL</text>
    </g>
    `;
  }
}

export const cardRenderer = new CardRenderer();
