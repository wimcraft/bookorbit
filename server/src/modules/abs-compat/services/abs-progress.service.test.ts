import { NotFoundException } from '@nestjs/common';

import { makeAudiobookFixture, makeUser } from '../abs-test-support';
import { AbsProgressService } from './abs-progress.service';

const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00.000Z`);

function setup() {
  const fixture = makeAudiobookFixture();
  const absRepo = {
    findProgressRows: vi.fn().mockResolvedValue([]),
    findTimelineFiles: vi.fn().mockResolvedValue([]),
  };
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([4, 5]) };
  const socketHub = { isListening: vi.fn().mockReturnValue(false), emitToUser: vi.fn() };
  const progress = new AbsProgressService(absRepo as never, fixture.service, libraryService as never, socketHub as never);
  return { ...fixture, absRepo, libraryService, socketHub, progress };
}

const timelineFiles = [
  { id: 12, publicId: 'b', bookId: 30, absolutePath: '/library/Part 2.mp3', sortOrder: 2, durationSeconds: 20 },
  { id: 11, publicId: 'a', bookId: 30, absolutePath: '/library/Part 1.mp3', sortOrder: 1, durationSeconds: 10 },
  { id: 21, publicId: 'c', bookId: 31, absolutePath: '/library/Solo.m4b', sortOrder: null, durationSeconds: 100 },
];

const row = (overrides: Record<string, unknown>) => ({
  bookId: 30,
  libraryId: 4,
  currentFileId: 12,
  positionSeconds: 5,
  percentage: 50,
  capturedAt: at('18:00'),
  readStatus: 'reading',
  startedAt: null,
  finishedAt: null,
  metaDurationSeconds: 30,
  ...overrides,
});

describe('AbsProgressService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T21:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('reading progress', () => {
    it('builds absolute positions across files with two queries for any number of books', async () => {
      const { progress, absRepo, libraryService } = setup();
      absRepo.findProgressRows.mockResolvedValue([
        row({}),
        row({ bookId: 31, currentFileId: 21, positionSeconds: 40, percentage: 40, metaDurationSeconds: 100 }),
      ]);
      absRepo.findTimelineFiles.mockResolvedValue(timelineFiles);

      const result = await progress.listForUser(makeUser(7));

      expect(result.map((entry) => [entry.libraryItemId, entry.currentTime, entry.duration, entry.progress])).toEqual([
        ['li-30', 15, 30, 0.5],
        ['li-31', 40, 100, 0.4],
      ]);
      expect(libraryService.findAccessibleLibraryIds).toHaveBeenCalledTimes(1);
      expect(absRepo.findProgressRows).toHaveBeenCalledTimes(1);
      expect(absRepo.findProgressRows).toHaveBeenCalledWith(7, [4, 5], 1000, undefined);
      expect(absRepo.findTimelineFiles).toHaveBeenCalledTimes(1);
      expect(absRepo.findTimelineFiles).toHaveBeenCalledWith([30, 31]);
    });

    it('skips a row whose current file is no longer part of the book', async () => {
      const { progress, absRepo } = setup();
      absRepo.findProgressRows.mockResolvedValue([row({ currentFileId: 999 })]);
      absRepo.findTimelineFiles.mockResolvedValue(timelineFiles);

      await expect(progress.listForUser(makeUser())).resolves.toEqual([]);
    });

    it('makes no timeline query when there is no progress', async () => {
      const { progress, absRepo } = setup();

      await expect(progress.listForUser(makeUser())).resolves.toEqual([]);
      expect(absRepo.findTimelineFiles).not.toHaveBeenCalled();
    });

    it('reads one book by progress id or library item id and 404s when there is none', async () => {
      const { progress, absRepo } = setup();
      absRepo.findProgressRows.mockResolvedValue([row({})]);
      absRepo.findTimelineFiles.mockResolvedValue(timelineFiles);

      await expect(progress.getOne(makeUser(), 'mp-30')).resolves.toEqual(expect.objectContaining({ id: 'mp-30', currentTime: 15 }));
      await expect(progress.getOne(makeUser(), 'li-30')).resolves.toEqual(expect.objectContaining({ id: 'mp-30' }));
      expect(absRepo.findProgressRows).toHaveBeenLastCalledWith(7, [4, 5], 1, 30);

      absRepo.findProgressRows.mockResolvedValue([]);
      await expect(progress.getOne(makeUser(), 'mp-31')).rejects.toThrow(NotFoundException);
      await expect(progress.getOne(makeUser(), 'nonsense')).rejects.toThrow(NotFoundException);
    });
  });

  describe('writing progress', () => {
    it('applies a position stamped with the client lastUpdate', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(), 'li-30', {
        currentTime: 25,
        duration: 30,
        progress: 0.8,
        isFinished: false,
        lastUpdate: at('18:00').getTime(),
      });

      const stored = rows.get(key(7, 30))!;
      expect(stored).toEqual(expect.objectContaining({ currentFileId: 12, positionSeconds: 15 }));
      expect(stored.capturedAt).toEqual(at('18:00'));
    });

    it('stamps with the server clock when the client sends no lastUpdate', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(), 'li-30', { currentTime: 5 });

      expect(rows.get(key(7, 30))!.capturedAt).toEqual(new Date('2026-03-10T21:00:00.000Z'));
    });

    it('does not let an older client update overwrite newer progress', async () => {
      const { progress, rows, key, service } = setup();
      await service.applyExternalPosition(30, makeUser(), { absolutePositionMs: 4_000, capturedAt: at('20:00') });

      await progress.patchOne(makeUser(), 'li-30', { currentTime: 25, lastUpdate: at('18:00').getTime() });

      expect(rows.get(key(7, 30))!.positionSeconds).toBe(4);
    });

    it('clamps a lastUpdate from the future', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(), 'li-30', { currentTime: 5, lastUpdate: Date.now() + 10 * 86_400_000 });

      expect(rows.get(key(7, 30))!.capturedAt.getTime()).toBe(Date.now());
    });

    it('marks a book finished at the end', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(), 'li-30', { isFinished: true });

      expect(rows.get(key(7, 30))).toEqual(expect.objectContaining({ currentFileId: 12, positionSeconds: 20, percentage: 100 }));
    });

    it('rewinds a finished book to the start when marked not finished, so it counts as a reread', async () => {
      const { progress, rows, key, bookService } = setup();
      await progress.patchOne(makeUser(), 'li-30', { isFinished: true });

      await progress.patchOne(makeUser(), 'li-30', { isFinished: false });

      expect(rows.get(key(7, 30))).toEqual(expect.objectContaining({ positionSeconds: 0, percentage: 0 }));
      expect(bookService.autoUpdateReadStatusForProgress).toHaveBeenLastCalledWith(7, expect.objectContaining({ bookId: 30 }), 0, {
        origin: 'bookorbit',
        strongRereadEvidence: true,
      });
    });

    it('deletes progress through the progress id', async () => {
      const { progress, rows, key, repo, service } = setup();
      await service.applyExternalPosition(30, makeUser(), { absolutePositionMs: 4_000, capturedAt: at('17:30') });

      await progress.remove(makeUser(), 'mp-30');

      expect(rows.has(key(7, 30))).toBe(false);
      expect(repo.deletePlaybackState).toHaveBeenLastCalledWith(7, 30);
    });

    it('keeps a position when marked not finished but a time is given', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(), 'li-30', { isFinished: false, currentTime: 12 });

      expect(rows.get(key(7, 30))!.positionSeconds).toBe(2);
    });

    it('only ever touches the calling user', async () => {
      const { progress, rows, key } = setup();

      await progress.patchOne(makeUser(8), 'li-30', { currentTime: 25 });
      await progress.remove(makeUser(7), 'mp-30');

      expect(rows.get(key(8, 30))).toBeDefined();
    });

    it('applies a batch and survives entries that cannot be applied', async () => {
      const { progress, rows, key } = setup();
      const warn = vi.spyOn(progress['logger'], 'warn').mockImplementation(() => undefined);

      const summary = await progress.patchBatch(makeUser(), [
        { libraryItemId: 'li-30', currentTime: 5 },
        { libraryItemId: 'li-999', currentTime: 5 },
        { libraryItemId: 'bogus', currentTime: 5 },
        'junk',
        { libraryItemId: 'li-31', currentTime: 50, lastUpdate: at('18:00').getTime() },
      ]);

      expect(summary).toEqual({ applied: 2, failed: 3 });
      expect(rows.get(key(7, 30))!.positionSeconds).toBe(5);
      expect(rows.get(key(7, 31))!.positionSeconds).toBe(50);
      expect(warn).toHaveBeenCalledTimes(3);
    });
  });

  describe('publishing to connected apps', () => {
    it('pushes the stored progress after a patch that changed it', async () => {
      const { progress, absRepo, socketHub } = setup();
      socketHub.isListening.mockReturnValue(true);
      absRepo.findProgressRows.mockResolvedValue([row({ positionSeconds: 8 })]);
      absRepo.findTimelineFiles.mockResolvedValue(timelineFiles);

      await progress.patchOne(makeUser(7), 'li-30', { currentTime: 18 });

      expect(socketHub.emitToUser).toHaveBeenCalledWith(
        7,
        'user_item_progress_updated',
        expect.objectContaining({ id: 'mp-30', sessionId: null, data: expect.objectContaining({ libraryItemId: 'li-30', currentTime: 18 }) }),
      );
    });

    it('does not query when no app is listening', async () => {
      const { progress, absRepo, socketHub } = setup();

      await progress.patchOne(makeUser(7), 'li-30', { currentTime: 18 });

      expect(absRepo.findProgressRows).not.toHaveBeenCalled();
      expect(socketHub.emitToUser).not.toHaveBeenCalled();
    });

    it('never fails the write when the event cannot be built', async () => {
      const { progress, absRepo, socketHub } = setup();
      socketHub.isListening.mockReturnValue(true);
      absRepo.findProgressRows.mockRejectedValue(new Error('db down'));
      vi.spyOn(progress['logger'], 'warn').mockImplementation(() => undefined);

      await expect(progress.patchOne(makeUser(7), 'li-30', { currentTime: 18 })).resolves.toBeUndefined();
      expect(progress['logger'].warn).toHaveBeenCalledWith(expect.stringContaining('[abs.progress_publish] [fail]'));
    });
  });
});
