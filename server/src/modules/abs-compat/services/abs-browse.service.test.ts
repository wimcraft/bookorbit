import { NotFoundException } from '@nestjs/common';

import { makeUser } from '../abs-test-support';
import { AbsBrowseService, parseAuthorsQuery } from './abs-browse.service';

const minified = (bookId: number) => ({ id: `li-${bookId}`, libraryId: 'lib-1', media: { numTracks: 1 } });
const seriesRow = (id: number, name: string) => ({ id, name, createdAt: new Date(1_000), updatedAt: new Date(2_000) });

function setup() {
  const repo = {
    findSeriesPage: vi.fn().mockResolvedValue({ rows: [seriesRow(1, 'Visible Saga'), seriesRow(2, 'Hidden Saga')], total: 2 }),
    findSeriesBookIds: vi.fn().mockResolvedValue([
      { seriesId: 1, bookId: 10 },
      { seriesId: 1, bookId: 11 },
      { seriesId: 2, bookId: 20 },
    ]),
    findSeriesById: vi.fn().mockResolvedValue(seriesRow(1, 'Visible Saga')),
    findAuthorsPage: vi.fn().mockResolvedValue({ rows: [{ id: 5, name: 'Writer', description: null, hasPhoto: true, numBooks: 2 }], total: 1 }),
    searchSeries: vi.fn().mockResolvedValue([]),
  };
  const libraryService = {
    bookScope: vi.fn().mockReturnValue('scope'),
    requireBookLibrary: vi.fn().mockResolvedValue(undefined),
    accessibleBookLibraryIds: vi.fn().mockResolvedValue([1]),
    // Book 20 is hidden from this user by a content filter, so it never comes back as a card.
    minifiedByIds: vi.fn((_user: unknown, _libraries: number[], bookIds: number[]) =>
      Promise.resolve(bookIds.filter((id) => id !== 20).map(minified)),
    ),
  };
  const itemService = { minifyCards: vi.fn().mockResolvedValue([]) };
  const bookService = { queryForLibrary: vi.fn(), executeBooksQuery: vi.fn() };
  const service = new AbsBrowseService(repo as never, libraryService as never, itemService as never, bookService as never);
  return { service, repo, libraryService };
}

describe('parseAuthorsQuery', () => {
  it('returns every author up to the cap when the app does not paginate', () => {
    expect(parseAuthorsQuery({})).toEqual({ paginated: false, limit: 1000, page: 0, sort: 'name', sortBy: 'name', descending: false });
  });

  it('paginates and sorts by book count when asked', () => {
    expect(parseAuthorsQuery({ limit: '20', page: '2', sort: 'numBooks', desc: '1' })).toEqual({
      paginated: true,
      limit: 20,
      page: 2,
      sort: 'numBooks',
      sortBy: 'numBooks',
      descending: true,
    });
    expect(parseAuthorsQuery({ limit: '5000', page: '0' }).limit).toBe(1000);
  });
});

describe('AbsBrowseService', () => {
  it('lists series with their books in series order and drops series whose books the user cannot see', async () => {
    const { service, repo } = setup();

    const page = await service.listSeries(makeUser(), 'lib-1', { limit: 10_000, page: 0, sort: 'name', desc: false, filter: '', minified: true });

    expect(page.results.map((series) => [series.name, series.books.map((book) => book.id)])).toEqual([['Visible Saga', ['li-10', 'li-11']]]);
    expect(page.limit).toBe(500);
    expect(repo.findSeriesPage).toHaveBeenCalledWith('scope', 500, 0, false);
  });

  it('refuses a series with no visible books', async () => {
    const { service, repo } = setup();
    repo.findSeriesBookIds.mockResolvedValue([{ seriesId: 2, bookId: 20 }]);

    await expect(service.getSeries(makeUser(), 'ser-2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers authors as a bare list unless the app paginates', async () => {
    const { service } = setup();

    await expect(service.listAuthors(makeUser(), 'lib-1', parseAuthorsQuery({}))).resolves.toEqual({
      authors: [expect.objectContaining({ id: 'aut-5', name: 'Writer', numBooks: 2, imagePath: 'author-image', libraryId: 'lib-1' })],
    });
    await expect(service.listAuthors(makeUser(), 'lib-1', parseAuthorsQuery({ limit: '10', page: '0' }))).resolves.toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ id: 'aut-5' })], total: 1, limit: 10, page: 0 }),
    );
  });

  it('returns an empty search result for a blank term without querying', async () => {
    const { service, repo } = setup();

    await expect(service.search(makeUser(), 'lib-1', '  ', undefined)).resolves.toEqual({
      book: [],
      podcast: [],
      narrators: [],
      tags: [],
      genres: [],
      series: [],
      authors: [],
    });
    expect(repo.searchSeries).not.toHaveBeenCalled();
  });

  it('checks library access before browsing', async () => {
    const { service, libraryService } = setup();
    libraryService.requireBookLibrary.mockRejectedValue(new NotFoundException('Library not found'));

    await expect(
      service.listSeries(makeUser(), 'lib-9', { limit: 10, page: 0, sort: '', desc: false, filter: '', minified: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
