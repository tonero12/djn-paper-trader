/**
 * @file server/utils/decimal.ts
 * Deterministic decimal arithmetic and financial formatters
 */

import Decimal from 'decimal.js';

// Configure Decimal precision and rounding mode (half-up)
Decimal.set({ precision: 36, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function D(val: string | number | Decimal): Decimal {
  if (val instanceof Decimal) return val;
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) return new Decimal(0);
    return new Decimal(val.toString());
  }
  if (!val || typeof val !== 'string' || val.trim() === '') {
    return new Decimal(0);
  }
  try {
    return new Decimal(val.trim());
  } catch {
    return new Decimal(0);
  }
}

/**
 * Format currency in USD with commas: e.g. "$1,234.56" or "-$45.00"
 */
export function formatUsd(val: string | number | Decimal, includeSign: boolean = false): string {
  const d = D(val);
  const isNeg = d.isNegative();
  const absD = d.abs();
  
  // Choose decimal places: if >= $1, 2 decimals; if < $1 and > 0, up to 6 decimals
  let formattedNumber: string;
  if (absD.gte(1)) {
    formattedNumber = absD.toFixed(2);
  } else if (absD.gt(0)) {
    formattedNumber = absD.toDecimalPlaces(6).toString();
  } else {
    formattedNumber = '0.00';
  }

  // Add thousand separators for whole part
  const parts = formattedNumber.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formattedStr = parts.join('.');

  if (isNeg) {
    return `-$${formattedStr}`;
  }
  if (includeSign && d.gt(0)) {
    return `+$${formattedStr}`;
  }
  return `$${formattedStr}`;
}

/**
 * Format a token price with appropriate precision
 * e.g. $0.00004123 or $1.45
 */
export function formatPrice(val: string | number | Decimal): string {
  const d = D(val);
  if (d.isZero()) return '$0.00';

  if (d.gte(1000)) {
    return `$${d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
  if (d.gte(1)) {
    return `$${d.toFixed(4)}`;
  }
  if (d.gte(0.01)) {
    return `$${d.toFixed(5)}`;
  }
  // For micro prices (memecoins like $0.00000451)
  const str = d.toFixed(10);
  // Trim trailing zeros
  const trimmed = str.replace(/0+$/, '');
  return `$${trimmed}`;
}

/**
 * Format token quantity with commas and reasonable precision
 */
export function formatQuantity(val: string | number | Decimal): string {
  const d = D(val);
  if (d.isZero()) return '0';

  let formatted: string;
  if (d.gte(1000000)) {
    formatted = d.toFixed(2);
  } else if (d.gte(1)) {
    formatted = d.toFixed(4);
  } else {
    formatted = d.toFixed(6);
  }

  // Strip trailing zeros after decimal point
  if (formatted.includes('.')) {
    formatted = formatted.replace(/\.?0+$/, '');
  }

  const parts = formatted.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

/**
 * Format percentage: e.g. "+15.00%" or "-8.25%"
 */
export function formatPercent(val: string | number | Decimal, includeSign: boolean = true): string {
  const d = D(val);
  if (d.isZero()) return '0.00%';
  const isPos = d.gt(0);
  const formatted = d.toFixed(2);
  if (isPos && includeSign) {
    return `+${formatted}%`;
  }
  return `${formatted}%`;
}

/**
 * Safe division returning Decimal(0) on zero denominator
 */
export function safeDivide(numerator: string | number | Decimal, denominator: string | number | Decimal): Decimal {
  const num = D(numerator);
  const den = D(denominator);
  if (den.isZero()) return new Decimal(0);
  return num.dividedBy(den);
}

/**
 * Calculate percentage return: (pnl / costBasis) * 100
 */
export function calculateReturnPercent(pnl: string | number | Decimal, costBasis: string | number | Decimal): Decimal {
  const c = D(costBasis);
  if (c.isZero()) return new Decimal(0);
  return D(pnl).dividedBy(c).times(100);
}
