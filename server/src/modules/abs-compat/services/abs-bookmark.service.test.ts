import { BadRequestException, NotFoundException } from '@nestjs/common';

import { makeAudiobookFixture, makeUser } from '../abs-test-support';
import { AbsBookmarkService } from './abs-bookmark.service';

function setup(options: { inaccessibleBookIds?: number[] } = {}) {
  const fixture = makeAudiobookFixture(options);
  const absRepo = {
    findUserAudioBookmarks: vi.fn((userId: number) =>
      Promise.resolve(
        [...fixture.bookmarks.values()]
          .filter((row) => row.userId === userId)
          .map(({ bookId, title, positionSeconds, createdAt }) => ({ bookId, title, positionSeconds, createdAt })),
      ),
    ),
  };
  const bookmarks = new AbsBookmarkService(fixture.service, absRepo as never);
  return { ...fixture, absRepo, bookmarkService: bookmarks };
}

describe('AbsBookmarkService', () => {
  it('creates a bookmark at a time and returns it in the ABS shape', async () => {
    const { bookmarkService } = setup();

    const created = await bookmarkService.create(makeUser(), 'li-30', { time: 12.5, title: 'Big reveal' });

    expect(created).toEqual({ libraryItemId: 'li-30', title: 'Big reveal', time: 12.5, createdAt: expect.any(Number) });
    await expect(bookmarkService.listForUser(makeUser())).resolves.toEqual([
      expect.objectContaining({ libraryItemId: 'li-30', title: 'Big reveal' }),
    ]);
  });

  it('renames instead of duplicating when a bookmark already sits at that time', async () => {
    const { bookmarkService, bookmarks } = setup();
    await bookmarkService.create(makeUser(), 'li-30', { time: 12.5, title: 'First' });

    const second = await bookmarkService.create(makeUser(), 'li-30', { time: 12.5, title: 'Renamed' });

    expect(second.title).toBe('Renamed');
    expect(bookmarks.size).toBe(1);
  });

  it('finds a bookmark by time despite the single precision the database stores', async () => {
    const { bookmarkService, bookmarks } = setup();
    const time = 29.123456;
    await bookmarkService.create(makeUser(), 'li-30', { time, title: 'Late' });
    expect([...bookmarks.values()][0]!.positionSeconds).not.toBe(time);

    await expect(bookmarkService.update(makeUser(), 'li-30', { time, title: 'Later' })).resolves.toEqual(expect.objectContaining({ title: 'Later' }));
    await bookmarkService.remove(makeUser(), 'li-30', String(time));

    expect(bookmarks.size).toBe(0);
  });

  it('keeps bookmarks a moment apart separate and updates the one at the exact time', async () => {
    const { bookmarkService, bookmarks } = setup();
    await bookmarkService.create(makeUser(), 'li-30', { time: 10, title: 'Ten' });
    await bookmarkService.create(makeUser(), 'li-30', { time: 10.4, title: 'Ten and a bit' });

    const updated = await bookmarkService.update(makeUser(), 'li-30', { time: 10.4, title: 'Renamed' });

    expect(bookmarks.size).toBe(2);
    expect(updated.time).toBeCloseTo(10.4, 3);
    expect([...bookmarks.values()].map((row) => row.title).sort()).toEqual(['Renamed', 'Ten']);
  });

  it('matches a time deep into a long book after single-precision storage', async () => {
    const { bookmarkService, service } = setup();
    vi.spyOn(service, 'listBookmarks').mockResolvedValue([
      {
        id: 'b1',
        bookId: 30,
        positionMs: Math.fround(359_999.987) * 1000,
        chapterId: null,
        title: 'Near the end',
        note: null,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const remove = vi.spyOn(service, 'deleteBookmark').mockResolvedValue(undefined);

    await bookmarkService.remove(makeUser(), 'li-30', '359999.987');

    expect(remove).toHaveBeenCalledWith(30, 'b1', expect.anything());
  });

  it('answers 404 for an update or delete at a time with no bookmark', async () => {
    const { bookmarkService } = setup();
    await bookmarkService.create(makeUser(), 'li-30', { time: 5, title: 'Five' });

    await expect(bookmarkService.update(makeUser(), 'li-30', { time: 6, title: 'Six' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(bookmarkService.remove(makeUser(), 'li-30', '6')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a missing title, a negative or missing time and a non-numeric delete time', async () => {
    const { bookmarkService } = setup();

    await expect(bookmarkService.create(makeUser(), 'li-30', { time: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bookmarkService.create(makeUser(), 'li-30', { time: -1, title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bookmarkService.create(makeUser(), 'li-30', { title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bookmarkService.remove(makeUser(), 'li-30', 'abc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps users apart and refuses books the user cannot see', async () => {
    const { bookmarkService } = setup({ inaccessibleBookIds: [31] });
    await bookmarkService.create(makeUser(7), 'li-30', { time: 5, title: 'Mine' });

    await expect(bookmarkService.remove(makeUser(8), 'li-30', '5')).rejects.toBeInstanceOf(NotFoundException);
    await expect(bookmarkService.listForUser(makeUser(8))).resolves.toEqual([]);
    await expect(bookmarkService.create(makeUser(7), 'li-31', { time: 5, title: 'Hidden' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a time past the end of the book', async () => {
    const { bookmarkService } = setup();

    await expect(bookmarkService.create(makeUser(), 'li-30', { time: 500, title: 'Too far' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
