import { NotFoundException } from '@nestjs/common';
import { AUDIO_FORMAT_LIST } from '@bookorbit/types';

import { makeUser } from '../abs-test-support';
import { AbsLibraryService, resolveSortField } from './abs-library.service';

const library = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'books',
  name: `Library ${id}`,
  displayOrder: id,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  ...overrides,
});

const minified = (bookId: number) => ({ id: `li-${bookId}`, libraryId: 'lib-3' });

function setup(libraries = [library(3), library(5, { type: 'podcasts' }), library(2)]) {
  const libraryService = { findAll: vi.fn().mockResolvedValue(libraries) };
  const bookService = {
    queryForLibrary: vi.fn().mockResolvedValue({ items: [{ id: 1 }, { id: 2 }], total: 77, page: 0, size: 50 }),
    executeBooksQuery: vi.fn().mockResolvedValue({ items: [] }),
  };
  const queryBuilder = { buildWhere: vi.fn().mockReturnValue(undefined) };
  const repo = {
    findLibraryStats: vi.fn().mockResolvedValue(new Map([[3, { totalItems: 4, totalSize: 40, totalDuration: 400, numAudioFiles: 8 }]])),
    findInProgressBookIds: vi.fn().mockResolvedValue([]),
    findFinishedBookIds: vi.fn().mockResolvedValue([]),
    seriesMembershipFilter: vi.fn().mockReturnValue('series-membership'),
    authorMembershipFilter: vi.fn().mockReturnValue('author-membership'),
  };
  const itemService = { minifyCards: vi.fn(async (cards: Array<{ id: number }>) => Promise.resolve(cards.map((card) => minified(card.id)))) };
  const service = new AbsLibraryService(libraryService as never, bookService as never, queryBuilder as never, repo as never, itemService as never);
  return { service, libraryService, bookService, queryBuilder, repo, itemService };
}

describe('resolveSortField', () => {
  it.each([
    ['media.metadata.title', 'title'],
    ['media.metadata.authorName', 'author'],
    ['media.metadata.authorNameLF', 'author'],
    ['addedAt', 'addedAt'],
    ['size', 'fileSize'],
    ['media.duration', 'title'],
    ['', 'title'],
    ['something.unknown', 'title'],
  ])('maps %j to %s', (sort, field) => {
    expect(resolveSortField(sort)).toBe(field);
  });
});

describe('AbsLibraryService', () => {
  describe('libraries', () => {
    it('lists only book libraries the user can open, in display order', async () => {
      const { service, libraryService } = setup();
      const user = makeUser();

      const libraries = await service.listLibraries(user, false);

      expect(libraryService.findAll).toHaveBeenCalledWith(user);
      expect(libraries.map((entry) => entry.id)).toEqual(['lib-2', 'lib-3']);
      expect(libraries[0]).toEqual(expect.objectContaining({ mediaType: 'book', name: 'Library 2' }));
      expect(libraries[0]).not.toHaveProperty('stats');
    });

    it('adds stats in one query and zeroes libraries without audiobooks', async () => {
      const { service, repo } = setup();

      const libraries = await service.listLibraries(makeUser(), true);

      expect(repo.findLibraryStats).toHaveBeenCalledTimes(1);
      expect(repo.findLibraryStats).toHaveBeenCalledWith([2, 3]);
      expect(libraries.map((entry) => entry.stats)).toEqual([
        { totalItems: 0, totalSize: 0, totalDuration: 0, numAudioFiles: 0 },
        { totalItems: 4, totalSize: 40, totalDuration: 400, numAudioFiles: 8 },
      ]);
    });

    it('picks the first library as the default and tolerates having none', async () => {
      await expect(setup().service.defaultLibraryId(makeUser())).resolves.toBe(2);
      await expect(setup([]).service.defaultLibraryId(makeUser())).resolves.toBeNull();
    });

    it('hides podcast and inaccessible libraries as not found', async () => {
      const { service } = setup();

      await expect(service.getLibrary(makeUser(), 'lib-3')).resolves.toEqual(expect.objectContaining({ id: 'lib-3' }));
      await expect(service.getLibrary(makeUser(), 'lib-5')).rejects.toThrow(NotFoundException);
      await expect(service.getLibrary(makeUser(), 'lib-99')).rejects.toThrow(NotFoundException);
      await expect(service.getLibrary(makeUser(), 'garbage')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listItems', () => {
    const query = { limit: 50, page: 2, sort: 'media.metadata.authorName', desc: true, filter: '', minified: true };
    const audioOnly = {
      type: 'group',
      join: 'AND',
      rules: [{ type: 'rule', field: 'format', operator: 'includesAny', value: [...AUDIO_FORMAT_LIST] }],
    };
    const b64 = (value: string) => Buffer.from(value).toString('base64');

    it('pages through visible audiobooks only with the sort the app asked for', async () => {
      const { service, bookService, queryBuilder, itemService } = setup();
      bookService.executeBooksQuery.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }], total: 77 });
      const user = makeUser(7, { contentFilters: { includeTagIds: [4] } as never });

      const result = await service.listItems(user, 'lib-3', query);

      expect(queryBuilder.buildWhere).toHaveBeenCalledWith(audioOnly, { accessibleLibraryIds: [3], userId: 7, contentFilters: user.contentFilters });
      expect(bookService.executeBooksQuery).toHaveBeenCalledWith(7, expect.anything(), {
        sort: [{ field: 'author', dir: 'desc' }],
        pagination: { page: 2, size: 50 },
      });
      expect(itemService.minifyCards).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
      expect(result).toEqual({
        results: [minified(1), minified(2)],
        total: 77,
        limit: 50,
        page: 2,
        sortBy: 'media.metadata.authorName',
        sortDesc: true,
        filterBy: '',
        mediaType: 'book',
        minified: true,
        collapseseries: false,
        include: '',
      });
    });

    it('lists a series in series order through its membership', async () => {
      const { service, bookService, repo } = setup();

      await service.listItems(makeUser(), 'lib-3', { ...query, filter: `series.${b64('ser-12')}` });

      expect(repo.seriesMembershipFilter).toHaveBeenCalledWith(12);
      expect(bookService.executeBooksQuery).toHaveBeenCalledWith(
        7,
        expect.anything(),
        expect.objectContaining({
          sort: [
            { field: 'seriesIndex', dir: 'asc' },
            { field: 'title', dir: 'asc' },
          ],
        }),
      );
    });

    it('filters by author id, and by genre and tag name through the query engine', async () => {
      const { service, repo, queryBuilder } = setup();

      await service.listItems(makeUser(), 'lib-3', { ...query, filter: `authors.${b64('aut-5')}` });
      await service.listItems(makeUser(), 'lib-3', { ...query, filter: `genres.${b64('Fantasy')}` });

      expect(repo.authorMembershipFilter).toHaveBeenCalledWith(5);
      expect(queryBuilder.buildWhere).toHaveBeenLastCalledWith(
        { ...audioOnly, rules: [...audioOnly.rules, { type: 'rule', field: 'genre', operator: 'includesAny', value: ['Fantasy'] }] },
        expect.anything(),
      );
    });

    it('answers an id it never issued with an empty page instead of an error', async () => {
      const { service, bookService, repo } = setup();

      await expect(service.listItems(makeUser(), 'lib-3', { ...query, filter: 'authors.xyz' })).resolves.toEqual(
        expect.objectContaining({ results: [] }),
      );
      expect(repo.authorMembershipFilter).not.toHaveBeenCalled();
      expect(bookService.executeBooksQuery).toHaveBeenCalledTimes(1);
    });

    it('does not query a podcast library or one the user cannot open', async () => {
      const { service, bookService } = setup();

      await expect(service.listItems(makeUser(), 'lib-5', query)).rejects.toThrow(NotFoundException);
      await expect(service.listItems(makeUser(), 'lib-99', query)).rejects.toThrow(NotFoundException);
      expect(bookService.executeBooksQuery).not.toHaveBeenCalled();
    });
  });

  describe('shelves', () => {
    it('builds continue listening, recently added and listen again, leaving out empty shelves', async () => {
      const { service, repo, bookService } = setup();
      repo.findInProgressBookIds.mockResolvedValue([
        { bookId: 9, capturedAt: new Date() },
        { bookId: 4, capturedAt: new Date() },
      ]);
      repo.findFinishedBookIds.mockResolvedValue([]);
      bookService.executeBooksQuery.mockResolvedValue({ items: [{ id: 4 }, { id: 9 }] });

      const shelves = await service.personalized(makeUser(7), 'lib-3');

      expect(shelves.map((shelf) => [shelf.id, shelf.labelStringKey, shelf.type, shelf.total, shelf.entities.map((entity) => entity.id)])).toEqual([
        ['continue-listening', 'LabelContinueListening', 'book', 2, ['li-9', 'li-4']],
        ['recently-added', 'LabelRecentlyAdded', 'book', 77, ['li-1', 'li-2']],
      ]);
      expect(repo.findInProgressBookIds).toHaveBeenCalledWith(7, [3], 20);
      expect(repo.findFinishedBookIds).toHaveBeenCalledWith(7, 3, 20);
      expect(bookService.queryForLibrary).toHaveBeenCalledWith(
        expect.anything(),
        3,
        expect.objectContaining({ sort: [{ field: 'addedAt', dir: 'desc' }], pagination: { page: 0, size: 20 } }),
      );
    });

    it('resolves shelf books through the access and content filter rules of the listing', async () => {
      const { service, repo, queryBuilder, bookService } = setup();
      repo.findInProgressBookIds.mockResolvedValue([{ bookId: 9, capturedAt: new Date() }]);
      const filters = { mode: 'allow' } as never;

      await service.personalized(makeUser(7, { contentFilters: filters }), 'lib-3');
      await service.personalized(makeUser(8, { isSuperuser: true, contentFilters: filters }), 'lib-3');

      expect(queryBuilder.buildWhere).toHaveBeenNthCalledWith(1, expect.anything(), {
        accessibleLibraryIds: [3],
        userId: 7,
        contentFilters: filters,
      });
      expect(queryBuilder.buildWhere).toHaveBeenNthCalledWith(2, expect.anything(), {
        accessibleLibraryIds: [3],
        userId: 8,
        contentFilters: undefined,
      });
      expect(bookService.executeBooksQuery).toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ pagination: { page: 0, size: 1 } }));
    });

    it('refuses shelves for a library the user cannot open', async () => {
      const { service, repo } = setup();

      await expect(service.personalized(makeUser(), 'lib-5')).rejects.toThrow(NotFoundException);
      expect(repo.findInProgressBookIds).not.toHaveBeenCalled();
    });
  });

  describe('items in progress', () => {
    it('lists the books across the accessible libraries with their last progress time', async () => {
      const { service, repo, bookService } = setup();
      const t1 = new Date('2026-03-10T18:00:00.000Z');
      const t2 = new Date('2026-03-09T18:00:00.000Z');
      repo.findInProgressBookIds.mockResolvedValue([
        { bookId: 2, capturedAt: t1 },
        { bookId: 1, capturedAt: t2 },
      ]);
      bookService.executeBooksQuery.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }] });

      const items = await service.itemsInProgress(makeUser(7));

      expect(repo.findInProgressBookIds).toHaveBeenCalledWith(7, [2, 3], 25);
      expect(items.map((item) => [item.id, item.progressLastUpdate])).toEqual([
        ['li-2', t1.getTime()],
        ['li-1', t2.getTime()],
      ]);
    });

    it('answers an empty list without querying books when nothing is in progress', async () => {
      const { service, bookService } = setup();

      await expect(service.itemsInProgress(makeUser())).resolves.toEqual([]);
      expect(bookService.executeBooksQuery).not.toHaveBeenCalled();
    });
  });
});
