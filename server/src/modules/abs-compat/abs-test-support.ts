import { NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookService } from '../audiobook/audiobook.service';

export const FIRST_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
export const SECOND_PUBLIC_ID = '22222222-2222-4222-8222-222222222222';

export function makeUser(id = 7, overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id,
    username: `listener${id}`,
    name: 'Listener',
    email: null,
    active: true,
    isDefaultPassword: false,
    tokenVersion: 1,
    sessionId: 3,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    isSuperuser: false,
    permissions: [],
    contentFilters: null as unknown as RequestUser['contentFilters'],
    authenticationMethod: 'password',
    ...overrides,
  };
}

export interface StoredPlaybackState {
  userId: number;
  bookId: number;
  currentFileId: number;
  positionSeconds: number;
  percentage: number;
  capturedAt: Date;
  operationId: string | null;
  manifestRevision: string | null;
  revision: number;
}

type WriteValues = Omit<StoredPlaybackState, 'userId' | 'bookId' | 'revision'>;

export interface StoredBookmark {
  userId: number;
  bookId: number;
  clientId: string;
  positionSeconds: number;
  chapterId: string | null;
  title: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The real AudiobookService over an in-memory playback table, so merge behavior is exercised end to
 * end instead of asserted against a mock. Two books: 30 (10s + 20s) and 31 (one 100s file).
 */
export function makeAudiobookFixture(options: { inaccessibleBookIds?: number[] } = {}) {
  const filesByBook: Record<number, Array<Record<string, unknown>>> = {
    30: [
      {
        id: 11,
        publicId: FIRST_PUBLIC_ID,
        absolutePath: '/library/Part 1.mp3',
        format: 'mp3',
        sizeBytes: 1_000,
        durationSeconds: 10,
        sortOrder: 1,
        mtime: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 12,
        publicId: SECOND_PUBLIC_ID,
        absolutePath: '/library/Part 2.mp3',
        format: 'mp3',
        sizeBytes: 2_000,
        durationSeconds: 20,
        sortOrder: 2,
        mtime: null,
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
    31: [
      {
        id: 21,
        publicId: '33333333-3333-4333-8333-333333333333',
        absolutePath: '/library/Solo.m4b',
        format: 'm4b',
        sizeBytes: 9_000,
        durationSeconds: 100,
        sortOrder: null,
        mtime: null,
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      },
    ],
  };
  const rows = new Map<string, StoredPlaybackState>();
  const key = (userId: number, bookId: number) => `${userId}:${bookId}`;
  const bookmarks = new Map<string, StoredBookmark>();
  const bookmarkKey = (userId: number, bookId: number, clientId: string) => `${userId}:${bookId}:${clientId}`;
  let bookmarkClock = Date.parse('2026-02-01T00:00:00.000Z');

  const repo = {
    findAudioFiles: vi.fn((bookId: number) => Promise.resolve(filesByBook[bookId] ?? [])),
    findPlaybackState: vi.fn((userId: number, bookId: number) => Promise.resolve(rows.get(key(userId, bookId)) ?? null)),
    createPlaybackState: vi.fn((userId: number, bookId: number, values: WriteValues) => {
      if (rows.has(key(userId, bookId))) return Promise.resolve(null);
      const row = { userId, bookId, ...values, revision: 1 };
      rows.set(key(userId, bookId), row);
      return Promise.resolve(row);
    }),
    updatePlaybackState: vi.fn((userId: number, bookId: number, baseRevision: number, values: WriteValues) => {
      const current = rows.get(key(userId, bookId));
      if (!current || current.revision !== baseRevision) return Promise.resolve(null);
      const row = { ...current, ...values, revision: current.revision + 1 };
      rows.set(key(userId, bookId), row);
      return Promise.resolve(row);
    }),
    deletePlaybackState: vi.fn((userId: number, bookId: number) => {
      rows.delete(key(userId, bookId));
      return Promise.resolve();
    }),
    findAudioBookmarks: vi.fn((userId: number, bookId: number) =>
      Promise.resolve(
        [...bookmarks.values()]
          .filter((row) => row.userId === userId && row.bookId === bookId)
          .sort((left, right) => left.positionSeconds - right.positionSeconds),
      ),
    ),
    // Postgres stores bookmark positions as `real`; Math.fround reproduces that precision loss.
    createAudioBookmark: vi.fn((userId: number, bookId: number, values: Omit<StoredBookmark, 'userId' | 'bookId' | 'createdAt' | 'updatedAt'>) => {
      const createdAt = new Date((bookmarkClock += 1_000));
      const row = { userId, bookId, ...values, positionSeconds: Math.fround(values.positionSeconds), createdAt, updatedAt: createdAt };
      bookmarks.set(bookmarkKey(userId, bookId, values.clientId), row);
      return Promise.resolve(row);
    }),
    updateAudioBookmark: vi.fn((userId: number, bookId: number, clientId: string, values: { title?: string; note?: string | null }) => {
      const current = bookmarks.get(bookmarkKey(userId, bookId, clientId));
      if (!current) return Promise.resolve(null);
      const row = { ...current, ...values, updatedAt: new Date((bookmarkClock += 1_000)) };
      bookmarks.set(bookmarkKey(userId, bookId, clientId), row);
      return Promise.resolve(row);
    }),
    deleteAudioBookmark: vi.fn((userId: number, bookId: number, clientId: string) =>
      Promise.resolve(bookmarks.delete(bookmarkKey(userId, bookId, clientId))),
    ),
  };
  const blocked = new Set(options.inaccessibleBookIds ?? []);
  const bookService = {
    verifyBookAccess: vi.fn((bookId: number) =>
      blocked.has(bookId) || !filesByBook[bookId] ? Promise.reject(new NotFoundException(`Book ${bookId} not found`)) : Promise.resolve(),
    ),
    getFileInfo: vi.fn(),
    getDetail: vi.fn((bookId: number) =>
      Promise.resolve({
        id: bookId,
        libraryId: 4,
        title: `Book ${bookId}`,
        folderPath: '/library',
        authors: [{ name: 'Author' }],
        coverSource: null,
        audioMetadata: { durationSeconds: bookId === 30 ? 30 : 100, narrators: [], chapters: [] },
      }),
    ),
    autoUpdateReadStatusForProgress: vi.fn().mockResolvedValue(undefined),
    syncEbookProgressForAudiobookPlayback: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AudiobookService(repo as never, bookService as never);
  return { service, repo, bookService, rows, key, bookmarks };
}
