import type { AbsAuthor, AbsLibraryItemMinified, AbsSeries } from '../abs-compat.types';
import type { AbsAuthorRow, AbsSeriesRow } from '../abs-compat.repository';
import { encodeAuthorId, encodeLibraryId, encodeSeriesId } from '../abs-ids';
import { titleIgnorePrefix } from './item.serializer';

export function toAbsSeriesSummary(row: AbsSeriesRow, libraryId: number): Omit<AbsSeries, 'books'> {
  return {
    id: encodeSeriesId(row.id),
    name: row.name,
    nameIgnorePrefix: titleIgnorePrefix(row.name),
    description: null,
    addedAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    libraryId: encodeLibraryId(libraryId),
  };
}

export function toAbsSeries(row: AbsSeriesRow, libraryId: number, books: AbsLibraryItemMinified[]): AbsSeries {
  return { ...toAbsSeriesSummary(row, libraryId), books };
}

/**
 * BookOrbit keeps no timestamps on authors, so both read as 0. `imagePath` is only a presence flag for
 * the apps, which then fetch `/api/authors/:id/image`; the real path stays on the server.
 */
export function toAbsAuthor(row: Pick<AbsAuthorRow, 'id' | 'name' | 'description' | 'hasPhoto'>, libraryId: number, numBooks: number): AbsAuthor {
  return {
    id: encodeAuthorId(row.id),
    asin: null,
    name: row.name,
    description: row.description,
    imagePath: row.hasPhoto ? 'author-image' : null,
    libraryId: encodeLibraryId(libraryId),
    addedAt: 0,
    updatedAt: 0,
    numBooks,
  };
}
