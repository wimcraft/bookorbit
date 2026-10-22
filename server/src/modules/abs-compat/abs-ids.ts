import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

const MAX_INT4 = 2_147_483_647;

function decodeNumeric(prefix: string, value: unknown): number {
  if (typeof value !== 'string') throw new NotFoundException('Not found');
  const match = new RegExp(`^${prefix}-([1-9][0-9]{0,9})$`).exec(value);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id) || id > MAX_INT4) throw new NotFoundException('Not found');
  return id;
}

export const encodeLibraryId = (libraryId: number): string => `lib-${libraryId}`;
export const decodeLibraryId = (value: unknown): number => decodeNumeric('lib', value);

export const encodeFolderId = (libraryId: number): string => `fol-${libraryId}`;

export const encodeItemId = (bookId: number): string => `li-${bookId}`;
export const decodeItemId = (value: unknown): number => decodeNumeric('li', value);

export const encodeMediaId = (bookId: number): string => `book-${bookId}`;

export const encodeProgressId = (bookId: number): string => `mp-${bookId}`;
export const decodeProgressId = (value: unknown): number => decodeNumeric('mp', value);

export const encodeUserId = (userId: number): string => `usr-${userId}`;
export const encodeSeriesId = (seriesId: number): string => `ser-${seriesId}`;
export const decodeSeriesId = (value: unknown): number => decodeNumeric('ser', value);
export const encodeAuthorId = (authorId: number): string => `aut-${authorId}`;
export const decodeAuthorId = (value: unknown): number => decodeNumeric('aut', value);

/** Accepts either form a client may hold for the same progress: its own id or the library item it belongs to. */
export function decodeProgressReference(value: unknown): number {
  if (typeof value === 'string' && value.startsWith('mp-')) return decodeProgressId(value);
  return decodeItemId(value);
}

const AUTH_METHOD_CODES: Record<string, string> = { password: 'p', oidc: 'o', magic_link: 'm', setup: 's', legacy: 'l' };
const AUTH_METHODS_BY_CODE: Record<string, string> = Object.fromEntries(Object.entries(AUTH_METHOD_CODES).map(([method, code]) => [code, method]));

export interface PlaybackSessionIdParts {
  bookId: number;
  userId: number;
  authSessionId: number;
  authMethod: string;
  nonce: string;
}

const SESSION_ID_PATTERN = /^ps-([1-9][0-9]{0,9})-([1-9][0-9]{0,9})-([1-9][0-9]{0,9})-([posml])-([0-9a-f]{16})-([0-9a-f]{32})$/;

function sessionMac(secret: string, parts: PlaybackSessionIdParts): string {
  const payload = `${parts.bookId}.${parts.userId}.${parts.authSessionId}.${AUTH_METHOD_CODES[parts.authMethod] ?? 'l'}.${parts.nonce}`;
  return createHmac('sha256', secret).update(`abs-playback-session:${payload}`).digest('hex').slice(0, 32);
}

/**
 * A playback session lives only in its id. The id names the book, the user and the sign-in it was
 * opened under, and is signed so that the unauthenticated track URL the apps build from it cannot be
 * forged for another book or user.
 */
export function encodePlaybackSessionId(
  secret: string,
  input: Omit<PlaybackSessionIdParts, 'nonce'>,
  nonce = randomBytes(8).toString('hex'),
): string {
  const parts: PlaybackSessionIdParts = { ...input, nonce };
  const code = AUTH_METHOD_CODES[parts.authMethod] ?? 'l';
  return `ps-${parts.bookId}-${parts.userId}-${parts.authSessionId}-${code}-${parts.nonce}-${sessionMac(secret, parts)}`;
}

function parseSessionIdStructure(value: unknown): { parts: PlaybackSessionIdParts; mac: string } {
  const match = typeof value === 'string' ? SESSION_ID_PATTERN.exec(value) : null;
  if (!match) throw new NotFoundException('Not found');
  const parts: PlaybackSessionIdParts = {
    bookId: Number(match[1]),
    userId: Number(match[2]),
    authSessionId: Number(match[3]),
    authMethod: AUTH_METHODS_BY_CODE[match[4]!]!,
    nonce: match[5]!,
  };
  if (parts.bookId > MAX_INT4 || parts.userId > MAX_INT4 || parts.authSessionId > MAX_INT4) throw new NotFoundException('Not found');
  return { parts, mac: match[6]! };
}

/** Reads the book out of a session id without proving who minted it; for authenticated calls that only need the book. */
export function decodePlaybackSessionBookId(value: unknown): number {
  return parseSessionIdStructure(value).parts.bookId;
}

export function verifyPlaybackSessionId(secret: string, value: unknown): PlaybackSessionIdParts {
  const { parts, mac } = parseSessionIdStructure(value);
  const expected = Buffer.from(sessionMac(secret, parts));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new NotFoundException('Not found');
  return parts;
}
