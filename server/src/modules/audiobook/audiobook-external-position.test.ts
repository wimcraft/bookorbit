import { ConflictException, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { AudiobookService } from './audiobook.service';

const FIRST_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PUBLIC_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-03-10T12:00:00.000Z');

function makeUser(id = 7): RequestUser {
  return {
    id,
    username: `listener${id}`,
    name: 'Listener',
    email: null,
    active: true,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    isSuperuser: false,
    permissions: [],
    contentFilters: null as unknown as RequestUser['contentFilters'],
  };
}

interface StoredState {
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

function makeFixture() {
  const files = [
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
  ];
  const rows = new Map<string, StoredState>();
  const key = (userId: number, bookId: number) => `${userId}:${bookId}`;
  const hooks: { beforeUpdate?: () => void } = {};

  const repo = {
    findAudioFiles: vi.fn().mockResolvedValue(files),
    findPlaybackState: vi.fn((userId: number, bookId: number) => Promise.resolve(rows.get(key(userId, bookId)) ?? null)),
    createPlaybackState: vi.fn((userId: number, bookId: number, values: Omit<StoredState, 'userId' | 'bookId' | 'revision'>) => {
      if (rows.has(key(userId, bookId))) return Promise.resolve(null);
      const row = { userId, bookId, ...values, revision: 1 };
      rows.set(key(userId, bookId), row);
      return Promise.resolve(row);
    }),
    updatePlaybackState: vi.fn(
      (userId: number, bookId: number, baseRevision: number, values: Omit<StoredState, 'userId' | 'bookId' | 'revision'>) => {
        hooks.beforeUpdate?.();
        const current = rows.get(key(userId, bookId));
        if (!current || current.revision !== baseRevision) return Promise.resolve(null);
        const row = { ...current, ...values, revision: current.revision + 1 };
        rows.set(key(userId, bookId), row);
        return Promise.resolve(row);
      },
    ),
    deletePlaybackState: vi.fn(),
  };
  const bookService = {
    verifyBookAccess: vi.fn().mockResolvedValue(undefined),
    getFileInfo: vi.fn(),
    getDetail: vi.fn().mockResolvedValue({
      id: 30,
      libraryId: 4,
      title: 'A Long Listen',
      folderPath: '/library/A Long Listen',
      authors: [{ name: 'Author' }],
      coverSource: null,
      audioMetadata: { durationSeconds: 30, narrators: [], chapters: [] },
    }),
    autoUpdateReadStatusForProgress: vi.fn().mockResolvedValue(undefined),
    syncEbookProgressForAudiobookPlayback: vi.fn().mockResolvedValue(undefined),
  };

  const seed = (state: Partial<StoredState> & { capturedAt: Date }, userId = 7) => {
    rows.set(key(userId, 30), {
      userId,
      bookId: 30,
      currentFileId: 11,
      positionSeconds: 0,
      percentage: 0,
      operationId: null,
      manifestRevision: null,
      revision: 1,
      ...state,
    });
  };

  return { service: new AudiobookService(repo as never, bookService as never), repo, bookService, rows, seed, hooks, key };
}

describe('AudiobookService.applyExternalPosition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [0, 11, 0],
    [5_000, 11, 5_000],
    [9_999, 11, 9_999],
    [10_000, 12, 0],
    [25_000, 12, 15_000],
    [30_000, 12, 20_000],
    [999_999, 12, 20_000],
    [-5_000, 11, 0],
  ])('maps absolute %ims to file %i at offset %ims', async (absolutePositionMs, fileId, offsetMs) => {
    const { service, rows, key } = makeFixture();

    const result = await service.applyExternalPosition(30, makeUser(), { absolutePositionMs, capturedAt: new Date('2026-03-10T11:00:00.000Z') });

    expect(result.applied).toBe(true);
    const stored = rows.get(key(7, 30))!;
    expect(stored.currentFileId).toBe(fileId);
    expect(stored.positionSeconds * 1000).toBeCloseTo(offsetMs, 3);
  });

  it('derives the percentage from the absolute position and creates revision one', async () => {
    const { service, rows, key, bookService } = makeFixture();

    const result = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 15_000,
      capturedAt: new Date('2026-03-10T11:00:00.000Z'),
    });

    expect(result.state).toEqual(expect.objectContaining({ revision: 1, positionMs: 5_000, completed: false }));
    expect(rows.get(key(7, 30))!.percentage).toBeCloseTo(50);
    expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenCalledWith(7, { bookId: 30, libraryId: 4 }, expect.closeTo(50), {});
  });

  it('keeps newer progress when an older offline session arrives later', async () => {
    const { service, repo, seed, rows, key } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T10:00:00.000Z'), currentFileId: 11, positionSeconds: 8, percentage: 26.6 });

    const result = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 25_000,
      capturedAt: new Date('2026-03-10T09:00:00.000Z'),
    });

    expect(result.applied).toBe(false);
    expect(result.state).toEqual(
      expect.objectContaining({ assetId: `aud_${FIRST_PUBLIC_ID}`, positionMs: 8_000, capturedAt: '2026-03-10T10:00:00.000Z' }),
    );
    expect(repo.updatePlaybackState).not.toHaveBeenCalled();
    expect(rows.get(key(7, 30))!.positionSeconds).toBe(8);
  });

  it('applies listening that happened after the stored position', async () => {
    const { service, seed, rows, key } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T09:00:00.000Z') });

    const result = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 25_000,
      capturedAt: new Date('2026-03-10T10:00:00.000Z'),
    });

    expect(result.applied).toBe(true);
    expect(rows.get(key(7, 30))).toEqual(expect.objectContaining({ currentFileId: 12, revision: 2 }));
  });

  it('writes at an equal timestamp when the position differs, and skips an identical replay', async () => {
    const { service, repo, seed, rows, key } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T10:00:00.000Z'), currentFileId: 11, positionSeconds: 2 });

    const moved = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 6_000,
      capturedAt: new Date('2026-03-10T10:00:00.000Z'),
    });
    expect(moved.applied).toBe(true);
    expect(rows.get(key(7, 30))!.positionSeconds).toBe(6);

    const replay = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 6_000,
      capturedAt: new Date('2026-03-10T10:00:00.000Z'),
    });
    expect(replay.applied).toBe(false);
    expect(replay.state?.revision).toBe(2);
    expect(repo.updatePlaybackState).toHaveBeenCalledTimes(1);
  });

  it('clamps a timestamp from the future to now so a skewed clock cannot pin progress', async () => {
    const { service, rows, key } = makeFixture();

    await service.applyExternalPosition(30, makeUser(), { absolutePositionMs: 4_000, capturedAt: new Date('2027-01-01T00:00:00.000Z') });

    expect(rows.get(key(7, 30))!.capturedAt.toISOString()).toBe(NOW.toISOString());

    const later = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 9_000,
      capturedAt: new Date('2026-03-10T12:30:00.000Z'),
    });
    expect(later.applied).toBe(true);
  });

  it('marks the book finished at the very end with a full percentage', async () => {
    const { service, rows, key } = makeFixture();

    const result = await service.applyExternalPosition(30, makeUser(), { absolutePositionMs: 0, capturedAt: NOW, finished: true });

    expect(result.state).toEqual(expect.objectContaining({ assetId: `aud_${SECOND_PUBLIC_ID}`, positionMs: 20_000, completed: true }));
    expect(rows.get(key(7, 30))!.percentage).toBe(100);
  });

  it('re-reads and retries once when another writer bumps the revision', async () => {
    const { service, repo, seed, rows, key, hooks } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T08:00:00.000Z') });
    let interfered = false;
    hooks.beforeUpdate = () => {
      if (interfered) return;
      interfered = true;
      const current = rows.get(key(7, 30))!;
      rows.set(key(7, 30), { ...current, revision: current.revision + 1, capturedAt: new Date('2026-03-10T08:30:00.000Z') });
    };

    const result = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 12_000,
      capturedAt: new Date('2026-03-10T09:00:00.000Z'),
    });

    expect(result.applied).toBe(true);
    expect(repo.updatePlaybackState).toHaveBeenCalledTimes(2);
    expect(rows.get(key(7, 30))).toEqual(expect.objectContaining({ currentFileId: 12, revision: 3 }));
  });

  it('gives up the retry when the concurrent writer listened later', async () => {
    const { service, seed, rows, key, hooks } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T08:00:00.000Z') });
    hooks.beforeUpdate = () => {
      const current = rows.get(key(7, 30))!;
      rows.set(key(7, 30), { ...current, revision: current.revision + 1, capturedAt: new Date('2026-03-10T11:00:00.000Z'), positionSeconds: 3 });
    };

    const result = await service.applyExternalPosition(30, makeUser(), {
      absolutePositionMs: 12_000,
      capturedAt: new Date('2026-03-10T09:00:00.000Z'),
    });

    expect(result.applied).toBe(false);
    expect(result.state?.positionMs).toBe(3_000);
  });

  it('surfaces a second consecutive revision conflict', async () => {
    const { service, repo, seed } = makeFixture();
    seed({ capturedAt: new Date('2026-03-10T08:00:00.000Z') });
    repo.updatePlaybackState.mockResolvedValue(null as never);

    await expect(service.applyExternalPosition(30, makeUser(), { absolutePositionMs: 12_000, capturedAt: NOW })).rejects.toThrow(ConflictException);
    expect(repo.updatePlaybackState).toHaveBeenCalledTimes(2);
  });

  it('refuses a book the user cannot access and writes nothing', async () => {
    const { service, repo, bookService } = makeFixture();
    bookService.verifyBookAccess.mockRejectedValue(new NotFoundException('Book 30 not found'));

    await expect(service.applyExternalPosition(30, makeUser(99), { absolutePositionMs: 1_000, capturedAt: NOW })).rejects.toThrow(NotFoundException);
    expect(repo.createPlaybackState).not.toHaveBeenCalled();
    expect(repo.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('keeps users apart: one account position never touches another', async () => {
    const { service, rows, key } = makeFixture();

    await service.applyExternalPosition(30, makeUser(7), { absolutePositionMs: 4_000, capturedAt: new Date('2026-03-10T11:00:00.000Z') });
    await service.applyExternalPosition(30, makeUser(8), { absolutePositionMs: 24_000, capturedAt: new Date('2026-03-10T10:00:00.000Z') });

    expect(rows.get(key(7, 30))!.positionSeconds).toBe(4);
    expect(rows.get(key(8, 30))).toEqual(expect.objectContaining({ currentFileId: 12, positionSeconds: 14 }));
  });
});
