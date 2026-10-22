import { Injectable, NotFoundException } from '@nestjs/common';
import { and, inArray } from 'drizzle-orm';
import { AUDIO_FORMAT_LIST, type GroupRule, type SortField } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { books } from '../../../db/schema';
import { BookQueryBuilder } from '../../book/book-query-builder.service';
import { BookService } from '../../book/book.service';
import { LibraryService } from '../../library/library.service';
import { ABS_ITEMS_IN_PROGRESS_LIMIT, ABS_SHELF_LIMIT } from '../abs-compat.constants';
import { AbsCompatRepository } from '../abs-compat.repository';
import type { AbsLibrary, AbsLibraryItemMinified, AbsShelf } from '../abs-compat.types';
import { decodeItemId, decodeLibraryId } from '../abs-ids';
import type { AbsListQuery } from '../abs-request';
import { emptyFilterData, toAbsLibrary } from '../serializers/library.serializer';
import { AbsItemService } from './abs-item.service';

const AUDIO_ONLY_FILTER: GroupRule = {
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
    const page = await this.bookService.queryForLibrary(user, libraryId, {
      filter: AUDIO_ONLY_FILTER,
      sort: [{ field: resolveSortField(query.sort), dir: query.desc ? 'desc' : 'asc' }],
      pagination: { page: query.page, size: query.limit },
    });
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
  private async minifiedByIds(user: RequestUser, libraryIds: number[], bookIds: number[]): Promise<AbsLibraryItemMinified[]> {
    if (bookIds.length === 0 || libraryIds.length === 0) return [];
    const scope = this.queryBuilder.buildWhere(AUDIO_ONLY_FILTER, {
      accessibleLibraryIds: libraryIds,
      userId: user.id,
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
    });
    const where = and(scope, inArray(books.id, bookIds));
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

  private async requireBookLibrary(user: RequestUser, libraryId: number): Promise<void> {
    const ids = await this.accessibleBookLibraryIds(user);
    if (!ids.includes(libraryId)) throw new NotFoundException('Library not found');
  }
}
