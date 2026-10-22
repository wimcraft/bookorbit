import { BadRequestException } from '@nestjs/common';

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readFiniteNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function requireFiniteNumber(source: Record<string, unknown>, key: string): number {
  const value = readFiniteNumber(source, key);
  if (value === undefined) throw new BadRequestException(`${key} must be a number`);
  return value;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export interface AbsListQuery {
  limit: number;
  page: number;
  sort: string;
  desc: boolean;
  filter: string;
  minified: boolean;
}

export function parseListQuery(query: Record<string, unknown>, defaultLimit: number, maxLimit: number): AbsListQuery {
  const rawLimit = Number.parseInt(queryValue(query.limit) ?? '', 10);
  const rawPage = Number.parseInt(queryValue(query.page) ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;
  return {
    limit,
    page,
    sort: queryValue(query.sort) ?? '',
    desc: queryValue(query.desc) === '1',
    filter: queryValue(query.filter) ?? '',
    minified: queryValue(query.minified) === '1',
  };
}

export function includesFlag(query: Record<string, unknown>, flag: string): boolean {
  return (queryValue(query.include) ?? '')
    .split(',')
    .map((part) => part.trim())
    .includes(flag);
}

const UA_RULES: Array<[RegExp, string]> = [
  [/soundleaf/i, 'SoundLeaf (iOS)'],
  [/okhttp|android|dalvik/i, 'Audiobookshelf app (Android)'],
  [/ios|iphone|ipad|darwin|cfnetwork|alamofire/i, 'Audiobookshelf app (iOS)'],
];

/** A label that makes the native session recognizable, and revocable, in the account's session list. */
export function deriveDeviceLabel(userAgent: string | undefined): string {
  const agent = userAgent ?? '';
  for (const [pattern, label] of UA_RULES) {
    if (pattern.test(agent)) return label;
  }
  return 'Audiobookshelf client';
}
