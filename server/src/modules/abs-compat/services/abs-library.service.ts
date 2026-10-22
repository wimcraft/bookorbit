import { Injectable, NotFoundException } from '@nestjs/common';
import { AUDIO_FORMAT_LIST, type GroupRule, type SortField } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { BookService } from '../../book/book.service';
import { LibraryService } from '../../library/library.service';
import { AbsCompatRepository } from '../abs-compat.repository';
import type { AbsLibrary } from '../abs-compat.types';
import { decodeLibraryId } from '../abs-ids';
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
