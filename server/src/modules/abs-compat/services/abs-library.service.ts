import { Injectable, NotFoundException } from '@nestjs/common';
import { and, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { AUDIO_FORMAT_LIST, type GroupRule, type SortField, type SortSpec } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { books } from '../../../db/schema';
import { BookQueryBuilder } from '../../book/book-query-builder.service';
import { BookService } from '../../book/book.service';
import { LibraryService } from '../../library/library.service';
import { ABS_ITEMS_IN_PROGRESS_LIMIT, ABS_SHELF_LIMIT } from '../abs-compat.constants';
import { AbsCompatRepository } from '../abs-compat.repository';
import type { AbsLibrary, AbsLibraryItemMinified, AbsShelf } from '../abs-compat.types';
import { decodeAuthorId, decodeItemId, decodeLibraryId, decodeSeriesId } from '../abs-ids';
import { parseListFilter, type AbsListFilter, type AbsListQuery } from '../abs-request';
import { emptyFilterData, toAbsLibrary } from '../serializers/library.serializer';
import { AbsItemService } from './abs-item.service';

export const AUDIO_ONLY_FILTER: GroupRule = {
  type: 'group',
  join: 'AND',
  rules: [{ type: 'rule', field: 'format', operator: 'includesAny', value: [...AUDIO_FORMAT_LIST] }],
};

const SORT_FIELD_MAP: Record<string, SortField> = {
  'media.metadata.title': 'title',
  'media.metadata.authorName': 'author',
  'media.metadata.authorNameLF': 'author',
  'media.metadata.publishedYear': 'publishedYear',
  addedAt: 'addedAt',
  birthtimeMs: 'addedAt',
  updatedAt: 'updatedAt',
  mtimeMs: 'updatedAt',
  size: 'fileSize',
  'media.size': 'fileSize',
  random: 'random',
};

export function resolveSortField(sort: string): SortField {
  return SORT_FIELD_MAP[sort] ?? 'title';
}

/** Genres and tags are matched by name through the query engine; series and authors by id, see membershipFilter. */
function filterRule(filter: AbsListFilter | null): GroupRule['rules'][number] | undefined {
  if (filter?.kind === 'genres') return { type: 'rule', field: 'genre', operator: 'includesAny', value: [filter.value] };
  if (filter?.kind === 'tags') return { type: 'rule', field: 'tag', operator: 'includesAny', value: [filter.value] };
  return undefined;
}

@Injectable()
export class AbsLibraryService {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly bookService: BookService,
    private readonly queryBuilder: BookQueryBuilder,
    private readonly repo: AbsCompatRepository,
    private readonly itemService: AbsItemService,
  ) {}

  async listLibraries(user: RequestUser, includeStats: boolean): Promise<AbsLibrary[]> {
    const libraries = await this.accessibleBookLibraries(user);
    const stats = includeStats ? await this.repo.findLibraryStats(libraries.map((library) => library.id)) : null;
    return libraries.map((library) => {
      const libraryStats = stats?.get(library.id);
      return toAbsLibrary(library, libraryStats ?? (stats ? { totalItems: 0, totalSize: 0, totalDuration: 0, numAudioFiles: 0 } : undefined));
    });
  }

  async getLibrary(user: RequestUser, libraryRef: unknown): Promise<AbsLibrary> {
    const libraryId = decodeLibraryId(libraryRef);
    const library = (await this.accessibleBookLibraries(user)).find((candidate) => candidate.id === libraryId);
    if (!library) throw new NotFoundException('Library not found');
    return toAbsLibrary(library);
  }

  filterData() {
    return emptyFilterData();
  }

  async defaultLibraryId(user: RequestUser): Promise<number | null> {
    const libraries = await this.accessibleBookLibraries(user);
    return libraries[0]?.id ?? null;
  }

  async accessibleBookLibraryIds(user: RequestUser): Promise<number[]> {
    return (await this.accessibleBookLibraries(user)).map((library) => library.id);
  }

  async listItems(user: RequestUser, libraryRef: unknown, query: AbsListQuery) {
    const libraryId = decodeLibraryId(libraryRef);
    await this.requireBookLibrary(user, libraryId);
    const filter = parseListFilter(query.filter);
    const sort: SortSpec[] =
      filter?.kind === 'series'
        ? [
            { field: 'seriesIndex', dir: 'asc' },
            { field: 'title', dir: 'asc' },
          ]
        : [{ field: resolveSortField(query.sort), dir: query.desc ? 'desc' : 'asc' }];
    const where = and(this.bookScope(user, [libraryId], filterRule(filter)), this.membershipFilter(filter));
    const page = await this.bookService.executeBooksQuery(user.id, where, { sort, pagination: { page: query.page, size: query.limit } });
    const results = await this.itemService.minifyCards(page.items);
    return {
      results,
      total: page.total,
      limit: query.limit,
      page: query.page,
      sortBy: query.sort,
      sortDesc: query.desc,
      filterBy: query.filter,
      mediaType: 'book' as const,
      minified: query.minified,
      collapseseries: false,
      include: '',
    };
  }

  /**
   * Where clause on `books` for the audiobooks a user may see in the given libraries: library access,
   * the user's content filters, the audio-only rule, and no books still being processed.
   */
  bookScope(user: RequestUser, libraryIds: number[], extraRule?: GroupRule['rules'][number]): SQL | undefined {
    const filter: GroupRule = extraRule ? { ...AUDIO_ONLY_FILTER, rules: [...AUDIO_ONLY_FILTER.rules, extraRule] } : AUDIO_ONLY_FILTER;
    const scope = this.queryBuilder.buildWhere(filter, {
      accessibleLibraryIds: libraryIds,
      userId: user.id,
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
    });
    return and(scope, ne(books.status, 'processing'));
  }

  async requireBookLibrary(user: RequestUser, libraryId: number): Promise<void> {
    const ids = await this.accessibleBookLibraryIds(user);
    if (!ids.includes(libraryId)) throw new NotFoundException('Library not found');
  }

  /** An id this server never issued matches nothing, as ABS answers an unknown filter value with an empty page. */
  private membershipFilter(filter: AbsListFilter | null): SQL | undefined {
    try {
      if (filter?.kind === 'series') return this.repo.seriesMembershipFilter(decodeSeriesId(filter.value));
      if (filter?.kind === 'authors') return this.repo.authorMembershipFilter(decodeAuthorId(filter.value));
    } catch (error) {
      if (error instanceof NotFoundException) return sql`false`;
      throw error;
    }
    return undefined;
  }

  async personalized(user: RequestUser, libraryRef: unknown): Promise<AbsShelf[]> {
    const libraryId = decodeLibraryId(libraryRef);
    await this.requireBookLibrary(user, libraryId);

    const [inProgress, finishedIds, recent] = await Promise.all([
      this.repo.findInProgressBookIds(user.id, [libraryId], ABS_SHELF_LIMIT),
      this.repo.findFinishedBookIds(user.id, libraryId, ABS_SHELF_LIMIT),
      this.bookService.queryForLibrary(user, libraryId, {
        filter: AUDIO_ONLY_FILTER,
        sort: [{ field: 'addedAt', dir: 'desc' }],
        pagination: { page: 0, size: ABS_SHELF_LIMIT },
      }),
    ]);
    const [continueItems, listenAgainItems, recentItems] = await Promise.all([
      this.minifiedByIds(
        user,
        [libraryId],
        inProgress.map((row) => row.bookId),
      ),
      this.minifiedByIds(user, [libraryId], finishedIds),
      this.itemService.minifyCards(recent.items),
    ]);

    const shelves: AbsShelf[] = [
      {
        id: 'continue-listening',
        label: 'Continue Listening',
        labelStringKey: 'LabelContinueListening',
        type: 'book',
        entities: continueItems,
        total: continueItems.length,
      },
      {
        id: 'recently-added',
        label: 'Recently Added',
        labelStringKey: 'LabelRecentlyAdded',
        type: 'book',
        entities: recentItems,
        total: recent.total,
      },
      {
        id: 'listen-again',
        label: 'Listen Again',
        labelStringKey: 'LabelListenAgain',
        type: 'book',
        entities: listenAgainItems,
        total: listenAgainItems.length,
      },
    ];
    return shelves.filter((shelf) => shelf.entities.length > 0);
  }

  async itemsInProgress(user: RequestUser): Promise<Array<AbsLibraryItemMinified & { progressLastUpdate: number }>> {
    const libraryIds = await this.accessibleBookLibraryIds(user);
    const rows = await this.repo.findInProgressBookIds(user.id, libraryIds, ABS_ITEMS_IN_PROGRESS_LIMIT);
    const items = await this.minifiedByIds(
      user,
      libraryIds,
      rows.map((row) => row.bookId),
    );
    const lastUpdateByBook = new Map(rows.map((row) => [row.bookId, row.capturedAt.getTime()]));
    return items.map((item) => ({ ...item, progressLastUpdate: lastUpdateByBook.get(decodeItemId(item.id)) ?? 0 }));
  }

  /** Cards for a short, already-ordered id list, through the same access and content-filter rules as the listing. */
  async minifiedByIds(user: RequestUser, libraryIds: number[], bookIds: number[]): Promise<AbsLibraryItemMinified[]> {
    if (bookIds.length === 0 || libraryIds.length === 0) return [];
    const where = and(this.bookScope(user, libraryIds), inArray(books.id, bookIds));
    const page = await this.bookService.executeBooksQuery(user.id, where, {
      sort: [{ field: 'title', dir: 'asc' }],
      pagination: { page: 0, size: bookIds.length },
    });
    const position = new Map(bookIds.map((id, index) => [id, index]));
    const ordered = [...page.items].sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0));
    return this.itemService.minifyCards(ordered);
  }

  private async accessibleBookLibraries(user: RequestUser) {
    const libraries = await this.libraryService.findAll(user);
    return libraries
      .filter((library) => library.type === 'books')
      .sort((left, right) => left.displayOrder - right.displayOrder || left.id - right.id);
  }
}
