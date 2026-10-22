import { Injectable, NotFoundException } from '@nestjs/common';
import { and } from 'drizzle-orm';

import type { RequestUser } from '../../../common/types/request-user';
import { BookService } from '../../book/book.service';
import {
  ABS_MAX_AUTHORS,
  ABS_MAX_SERIES_PAGE_SIZE,
  ABS_SEARCH_DEFAULT_LIMIT,
  ABS_SEARCH_MAX_LIMIT,
  ABS_SERIES_BOOKS_PER_SERIES,
} from '../abs-compat.constants';
import { AbsCompatRepository, type AbsAuthorSort } from '../abs-compat.repository';
import type { AbsAuthor, AbsLibraryItemMinified, AbsSearchResult, AbsSeries } from '../abs-compat.types';
import { decodeAuthorId, decodeItemId, decodeLibraryId, decodeSeriesId } from '../abs-ids';
import { queryValue, type AbsListQuery } from '../abs-request';
import { toAbsAuthor, toAbsSeries, toAbsSeriesSummary } from '../serializers/browse.serializer';
import { AbsItemService } from './abs-item.service';
import { AUDIO_ONLY_FILTER, AbsLibraryService } from './abs-library.service';

export interface AbsAuthorsQuery {
  paginated: boolean;
  limit: number;
  page: number;
  sort: AbsAuthorSort;
  sortBy: string;
  descending: boolean;
}

export function parseAuthorsQuery(query: Record<string, unknown>): AbsAuthorsQuery {
  const limit = Number.parseInt(queryValue(query.limit) ?? '', 10);
  const page = Number.parseInt(queryValue(query.page) ?? '', 10);
  const paginated = Number.isFinite(limit) && limit > 0 && Number.isFinite(page) && page >= 0;
  const sortBy = queryValue(query.sort) ?? 'name';
  return {
    paginated,
    limit: paginated ? Math.min(limit, ABS_MAX_AUTHORS) : ABS_MAX_AUTHORS,
    page: paginated ? page : 0,
    sort: sortBy === 'numBooks' ? 'numBooks' : 'name',
    sortBy,
    descending: queryValue(query.desc) === '1',
  };
}

/** Series, authors and search for one library, all scoped to the audiobooks the user may see there. */
@Injectable()
export class AbsBrowseService {
  constructor(
    private readonly repo: AbsCompatRepository,
    private readonly libraryService: AbsLibraryService,
    private readonly itemService: AbsItemService,
    private readonly bookService: BookService,
  ) {}

  async listSeries(user: RequestUser, libraryRef: unknown, query: AbsListQuery) {
    const libraryId = await this.requireLibrary(user, libraryRef);
    const limit = Math.min(query.limit, ABS_MAX_SERIES_PAGE_SIZE);
    const scope = this.libraryService.bookScope(user, [libraryId]);
    const { rows, total } = await this.repo.findSeriesPage(scope, limit, query.page * limit, query.desc);
    const booksBySeries = await this.seriesBooks(
      user,
      libraryId,
      rows.map((row) => row.id),
    );
    const results = rows.flatMap((row) => {
      const seriesBooks = booksBySeries.get(row.id) ?? [];
      return seriesBooks.length > 0 ? [toAbsSeries(row, libraryId, seriesBooks)] : [];
    });
    return {
      results,
      total,
      limit,
      page: query.page,
      sortBy: query.sort || 'name',
      sortDesc: query.desc,
      filterBy: query.filter,
      minified: query.minified,
      include: '',
    };
  }

  async getSeries(user: RequestUser, seriesRef: unknown, libraryRef?: unknown): Promise<AbsSeries> {
    const seriesId = decodeSeriesId(seriesRef);
    const libraryIds =
      libraryRef === undefined ? await this.libraryService.accessibleBookLibraryIds(user) : [await this.requireLibrary(user, libraryRef)];
    const row = await this.repo.findSeriesById(seriesId);
    if (!row || libraryIds.length === 0) throw new NotFoundException('Series not found');
    const ids = await this.repo.findSeriesBookIds([seriesId], this.libraryService.bookScope(user, libraryIds), ABS_SERIES_BOOKS_PER_SERIES);
    const seriesBooks = await this.libraryService.minifiedByIds(
      user,
      libraryIds,
      ids.map((entry) => entry.bookId),
    );
    if (seriesBooks.length === 0) throw new NotFoundException('Series not found');
    return toAbsSeries(row, decodeLibraryId(seriesBooks[0]!.libraryId), seriesBooks);
  }

  async listAuthors(user: RequestUser, libraryRef: unknown, query: AbsAuthorsQuery) {
    const libraryId = await this.requireLibrary(user, libraryRef);
    const { rows, total } = await this.repo.findAuthorsPage(this.libraryService.bookScope(user, [libraryId]), {
      limit: query.limit,
      offset: query.page * query.limit,
      sort: query.sort,
      descending: query.descending,
    });
    const authors = rows.map((row) => toAbsAuthor(row, libraryId, row.numBooks));
    if (!query.paginated) return { authors };
    return {
      results: authors,
      total,
      limit: query.limit,
      page: query.page,
      sortBy: query.sortBy,
      sortDesc: query.descending,
      filterBy: '',
      minified: false,
      include: '',
    };
  }

  async getAuthor(user: RequestUser, authorRef: unknown): Promise<AbsAuthor & { libraryItems: AbsLibraryItemMinified[] }> {
    const authorId = decodeAuthorId(authorRef);
    const libraryIds = await this.libraryService.accessibleBookLibraryIds(user);
    const author = await this.repo.findAuthorById(authorId);
    if (!author || libraryIds.length === 0) throw new NotFoundException('Author not found');
    const page = await this.bookService.executeBooksQuery(
      user.id,
      and(this.libraryService.bookScope(user, libraryIds), this.repo.authorMembershipFilter(authorId)),
      { sort: [{ field: 'title', dir: 'asc' }], pagination: { page: 0, size: ABS_MAX_SERIES_PAGE_SIZE } },
    );
    const libraryItems = await this.itemService.minifyCards(page.items);
    if (libraryItems.length === 0) throw new NotFoundException('Author not found');
    return { ...toAbsAuthor(author, decodeLibraryId(libraryItems[0]!.libraryId), page.total), libraryItems };
  }

  async search(user: RequestUser, libraryRef: unknown, rawTerm: unknown, rawLimit: unknown): Promise<AbsSearchResult> {
    const libraryId = await this.requireLibrary(user, libraryRef);
    const term = (queryValue(rawTerm) ?? '').trim();
    const parsedLimit = Number.parseInt(queryValue(rawLimit) ?? '', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, ABS_SEARCH_MAX_LIMIT) : ABS_SEARCH_DEFAULT_LIMIT;
    const empty: AbsSearchResult = { book: [], podcast: [], narrators: [], tags: [], genres: [], series: [], authors: [] };
    if (!term) return empty;

    const scope = this.libraryService.bookScope(user, [libraryId]);
    const [bookPage, seriesRows, authorPage] = await Promise.all([
      this.bookService.queryForLibrary(user, libraryId, {
        filter: AUDIO_ONLY_FILTER,
        q: term,
        sort: [{ field: 'relevance', dir: 'desc' }],
        pagination: { page: 0, size: limit },
      }),
      this.repo.searchSeries(scope, term, limit),
      this.repo.findAuthorsPage(scope, { limit, offset: 0, sort: 'name', descending: false, term }),
    ]);
    const [bookItems, seriesBooks] = await Promise.all([
      this.itemService.minifyCards(bookPage.items),
      this.seriesBooks(
        user,
        libraryId,
        seriesRows.map((row) => row.id),
      ),
    ]);
    return {
      ...empty,
      book: bookItems.map((libraryItem) => ({ libraryItem })),
      series: seriesRows.flatMap((row) => {
        const matched = seriesBooks.get(row.id) ?? [];
        if (matched.length === 0) return [];
        return [{ series: toAbsSeriesSummary(row, libraryId), books: matched }];
      }),
      authors: authorPage.rows.map((row) => toAbsAuthor(row, libraryId, row.numBooks)),
    };
  }

  private async seriesBooks(user: RequestUser, libraryId: number, seriesIds: number[]): Promise<Map<number, AbsLibraryItemMinified[]>> {
    const memberships = await this.repo.findSeriesBookIds(seriesIds, this.libraryService.bookScope(user, [libraryId]), ABS_SERIES_BOOKS_PER_SERIES);
    const items = await this.libraryService.minifiedByIds(user, [libraryId], [...new Set(memberships.map((entry) => entry.bookId))]);
    const itemsById = new Map(items.map((item) => [decodeItemId(item.id), item]));
    const result = new Map<number, AbsLibraryItemMinified[]>();
    for (const { seriesId, bookId } of memberships) {
      const item = itemsById.get(bookId);
      if (!item) continue;
      result.set(seriesId, [...(result.get(seriesId) ?? []), item]);
    }
    return result;
  }

  private async requireLibrary(user: RequestUser, libraryRef: unknown): Promise<number> {
    const libraryId = decodeLibraryId(libraryRef);
    await this.libraryService.requireBookLibrary(user, libraryId);
    return libraryId;
  }
}
