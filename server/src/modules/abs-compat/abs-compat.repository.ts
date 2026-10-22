import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AUDIO_FORMAT_LIST } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { accentInsensitiveIlike, buildSearchPattern } from '../../common/utils/accent-insensitive-search.utils';
import {
  audiobookProgress,
  authors,
  bookAuthors,
  bookFiles,
  bookMetadata,
  bookmarks,
  books,
  bookSeries,
  bookSeriesMemberships,
  libraryFolders,
  userBookStatus,
} from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

const AUDIO_FORMATS: string[] = [...AUDIO_FORMAT_LIST];

export interface AbsItemFacts {
  bookId: number;
  libraryId: number;
  folderPath: string;
  folderRoot: string;
  metaDurationSeconds: number | null;
  chapterCount: number;
  fileCount: number;
  sizeBytes: number;
  durationSeconds: number;
  missingDurations: number;
}

export interface AbsProgressRow {
  bookId: number;
  libraryId: number;
  currentFileId: number;
  positionSeconds: number;
  percentage: number;
  capturedAt: Date;
  readStatus: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  metaDurationSeconds: number | null;
}

export interface AbsTimelineFileRow {
  id: number;
  publicId: string;
  bookId: number;
  absolutePath: string;
  sortOrder: number | null;
  durationSeconds: number | null;
}

export interface AbsSeriesRow {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AbsAuthorRow {
  id: number;
  name: string;
  description: string | null;
  hasPhoto: boolean;
  numBooks: number;
}

export type AbsAuthorSort = 'name' | 'numBooks';

const SERIES_INDEX_ORDER = sql`(case when ${bookSeriesMemberships.seriesIndex} is null then null else array[split_part(${bookSeriesMemberships.seriesIndex}, '.', 1)::numeric, case when strpos(${bookSeriesMemberships.seriesIndex}, '.') = 0 then -1::numeric else split_part(${bookSeriesMemberships.seriesIndex}, '.', 2)::numeric end] end)`;

@Injectable()
export class AbsCompatRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** One query for everything a page of list items needs beyond the book cards. */
  async findItemFacts(bookIds: number[]): Promise<Map<number, AbsItemFacts>> {
    if (bookIds.length === 0) return new Map();
    const audio = this.db
      .select({
        bookId: bookFiles.bookId,
        fileCount: sql<number>`count(*)::int`.as('audio_file_count'),
        sizeBytes: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)::float8`.as('audio_size_bytes'),
        durationSeconds: sql<number>`coalesce(sum(${bookFiles.durationSeconds}), 0)::float8`.as('audio_duration_seconds'),
        missingDurations: sql<number>`(count(*) filter (where ${bookFiles.durationSeconds} is null or ${bookFiles.durationSeconds} = 0))::int`.as(
          'audio_missing_durations',
        ),
      })
      .from(bookFiles)
      .where(and(inArray(bookFiles.bookId, bookIds), inArray(bookFiles.format, AUDIO_FORMATS)))
      .groupBy(bookFiles.bookId)
      .as('audio');

    const rows = await this.db
      .select({
        bookId: books.id,
        libraryId: books.libraryId,
        folderPath: books.folderPath,
        folderRoot: libraryFolders.path,
        metaDurationSeconds: bookMetadata.durationSeconds,
        chapterCount: sql<number>`case when jsonb_typeof(${bookMetadata.chapters}) = 'array' then jsonb_array_length(${bookMetadata.chapters}) else 0 end`,
        fileCount: audio.fileCount,
        sizeBytes: audio.sizeBytes,
        durationSeconds: audio.durationSeconds,
        missingDurations: audio.missingDurations,
      })
      .from(books)
      .innerJoin(libraryFolders, eq(libraryFolders.id, books.libraryFolderId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .leftJoin(audio, eq(audio.bookId, books.id))
      .where(inArray(books.id, bookIds));

    return new Map(
      rows.map((row) => [
        row.bookId,
        {
          bookId: row.bookId,
          libraryId: row.libraryId,
          folderPath: row.folderPath,
          folderRoot: row.folderRoot,
          metaDurationSeconds: row.metaDurationSeconds,
          chapterCount: Number(row.chapterCount ?? 0),
          fileCount: row.fileCount ?? 0,
          sizeBytes: row.sizeBytes ?? 0,
          durationSeconds: row.durationSeconds ?? 0,
          missingDurations: row.missingDurations ?? 0,
        },
      ]),
    );
  }

  findAudioFileDetails(bookId: number) {
    return this.db
      .select({
        id: bookFiles.id,
        publicId: bookFiles.publicId,
        absolutePath: bookFiles.absolutePath,
        relPath: bookFiles.relPath,
        sizeBytes: bookFiles.sizeBytes,
        mtime: bookFiles.mtime,
        createdAt: bookFiles.createdAt,
        updatedAt: bookFiles.updatedAt,
      })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), inArray(bookFiles.format, AUDIO_FORMATS)));
  }

  findTimelineFiles(bookIds: number[]): Promise<AbsTimelineFileRow[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        id: bookFiles.id,
        publicId: bookFiles.publicId,
        bookId: bookFiles.bookId,
        absolutePath: bookFiles.absolutePath,
        sortOrder: bookFiles.sortOrder,
        durationSeconds: bookFiles.durationSeconds,
      })
      .from(bookFiles)
      .where(and(inArray(bookFiles.bookId, bookIds), inArray(bookFiles.format, AUDIO_FORMATS)));
  }

  /** The user's audiobook progress, newest first. Always scoped by user and by the libraries they can open. */
  findProgressRows(userId: number, accessibleLibraryIds: number[], limit: number, bookId?: number): Promise<AbsProgressRow[]> {
    if (accessibleLibraryIds.length === 0) return Promise.resolve([]);
    const conditions = [eq(audiobookProgress.userId, userId), inArray(books.libraryId, accessibleLibraryIds)];
    if (bookId !== undefined) conditions.push(eq(audiobookProgress.bookId, bookId));
    return this.db
      .select({
        bookId: audiobookProgress.bookId,
        libraryId: books.libraryId,
        currentFileId: audiobookProgress.currentFileId,
        positionSeconds: audiobookProgress.positionSeconds,
        percentage: audiobookProgress.percentage,
        capturedAt: audiobookProgress.capturedAt,
        readStatus: userBookStatus.status,
        startedAt: userBookStatus.startedAt,
        finishedAt: userBookStatus.finishedAt,
        metaDurationSeconds: bookMetadata.durationSeconds,
      })
      .from(audiobookProgress)
      .innerJoin(books, eq(books.id, audiobookProgress.bookId))
      .leftJoin(userBookStatus, and(eq(userBookStatus.bookId, audiobookProgress.bookId), eq(userBookStatus.userId, userId)))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, audiobookProgress.bookId))
      .where(and(...conditions))
      .orderBy(desc(audiobookProgress.capturedAt), desc(audiobookProgress.bookId))
      .limit(limit);
  }

  async findInProgressBookIds(userId: number, libraryIds: number[], limit: number): Promise<Array<{ bookId: number; capturedAt: Date }>> {
    if (libraryIds.length === 0) return [];
    return this.db
      .select({ bookId: audiobookProgress.bookId, capturedAt: audiobookProgress.capturedAt })
      .from(audiobookProgress)
      .innerJoin(books, eq(books.id, audiobookProgress.bookId))
      .leftJoin(userBookStatus, and(eq(userBookStatus.bookId, audiobookProgress.bookId), eq(userBookStatus.userId, userId)))
      .where(
        and(
          eq(audiobookProgress.userId, userId),
          inArray(books.libraryId, libraryIds),
          ne(books.status, 'processing'),
          sql`${audiobookProgress.percentage} > 0 and ${audiobookProgress.percentage} < 100`,
          sql`coalesce(${userBookStatus.status}, 'unread') <> 'read'`,
        ),
      )
      .orderBy(desc(audiobookProgress.capturedAt), desc(audiobookProgress.bookId))
      .limit(limit);
  }

  async findFinishedBookIds(userId: number, libraryId: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ bookId: books.id })
      .from(books)
      .leftJoin(audiobookProgress, and(eq(audiobookProgress.bookId, books.id), eq(audiobookProgress.userId, userId)))
      .leftJoin(userBookStatus, and(eq(userBookStatus.bookId, books.id), eq(userBookStatus.userId, userId)))
      .where(
        and(
          eq(books.libraryId, libraryId),
          ne(books.status, 'processing'),
          sql`(${userBookStatus.status} = 'read' or (${audiobookProgress.percentage} >= 100 and coalesce(${userBookStatus.status}, '') not in ('unread', 'want_to_read')))`,
          exists(
            this.db
              .select({ one: sql`1` })
              .from(bookFiles)
              .where(and(eq(bookFiles.bookId, books.id), inArray(bookFiles.format, AUDIO_FORMATS))),
          ),
        ),
      )
      .orderBy(sql`coalesce(${userBookStatus.finishedAt}, ${audiobookProgress.capturedAt}) desc nulls last`, desc(books.id))
      .limit(limit);
    return rows.map((row) => row.bookId);
  }

  async findLibraryStats(
    libraryIds: number[],
  ): Promise<Map<number, { totalItems: number; totalSize: number; totalDuration: number; numAudioFiles: number }>> {
    if (libraryIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        libraryId: books.libraryId,
        totalItems: sql<number>`count(distinct ${books.id})::int`,
        totalSize: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)::float8`,
        totalDuration: sql<number>`coalesce(sum(${bookFiles.durationSeconds}), 0)::float8`,
        numAudioFiles: sql<number>`count(${bookFiles.id})::int`,
      })
      .from(books)
      .innerJoin(bookFiles, eq(bookFiles.bookId, books.id))
      .where(and(inArray(books.libraryId, libraryIds), ne(books.status, 'processing'), inArray(bookFiles.format, AUDIO_FORMATS)))
      .groupBy(books.libraryId);
    return new Map(rows.map((row) => [row.libraryId, row]));
  }

  /**
   * Series with at least one book visible through `bookScope` (a where clause on `books` that already
   * carries library access, content filters and the audio-only rule), ordered by name.
   */
  async findSeriesPage(
    bookScope: SQL | undefined,
    limit: number,
    offset: number,
    descending: boolean,
  ): Promise<{ rows: AbsSeriesRow[]; total: number }> {
    const visible = exists(
      this.db
        .select({ one: sql`1` })
        .from(bookSeriesMemberships)
        .innerJoin(books, eq(books.id, bookSeriesMemberships.bookId))
        .where(and(eq(bookSeriesMemberships.seriesId, bookSeries.id), bookScope)),
    );
    const direction = descending ? desc : asc;
    const [rows, [count]] = await Promise.all([
      this.db
        .select({ id: bookSeries.id, name: bookSeries.name, createdAt: bookSeries.createdAt, updatedAt: bookSeries.updatedAt })
        .from(bookSeries)
        .where(visible)
        .orderBy(direction(sql`lower(${bookSeries.name})`), direction(bookSeries.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(bookSeries)
        .where(visible),
    ]);
    return { rows, total: count?.total ?? 0 };
  }

  /** Up to `perSeries` visible books of each series, in series order. One query for the whole page of series. */
  async findSeriesBookIds(seriesIds: number[], bookScope: SQL | undefined, perSeries: number): Promise<Array<{ seriesId: number; bookId: number }>> {
    if (seriesIds.length === 0) return [];
    const ranked = this.db
      .select({
        seriesId: bookSeriesMemberships.seriesId,
        bookId: bookSeriesMemberships.bookId,
        rank: sql<number>`row_number() over (partition by ${bookSeriesMemberships.seriesId} order by ${SERIES_INDEX_ORDER} nulls last, ${books.id})`.as(
          'series_rank',
        ),
      })
      .from(bookSeriesMemberships)
      .innerJoin(books, eq(books.id, bookSeriesMemberships.bookId))
      .where(and(inArray(bookSeriesMemberships.seriesId, seriesIds), bookScope))
      .as('ranked');
    return this.db
      .select({ seriesId: ranked.seriesId, bookId: ranked.bookId })
      .from(ranked)
      .where(lte(ranked.rank, perSeries))
      .orderBy(ranked.seriesId, ranked.rank);
  }

  async findSeriesById(seriesId: number): Promise<AbsSeriesRow | null> {
    const [row] = await this.db
      .select({ id: bookSeries.id, name: bookSeries.name, createdAt: bookSeries.createdAt, updatedAt: bookSeries.updatedAt })
      .from(bookSeries)
      .where(eq(bookSeries.id, seriesId))
      .limit(1);
    return row ?? null;
  }

  async searchSeries(bookScope: SQL | undefined, term: string, limit: number): Promise<AbsSeriesRow[]> {
    const visible = exists(
      this.db
        .select({ one: sql`1` })
        .from(bookSeriesMemberships)
        .innerJoin(books, eq(books.id, bookSeriesMemberships.bookId))
        .where(and(eq(bookSeriesMemberships.seriesId, bookSeries.id), bookScope)),
    );
    return this.db
      .select({ id: bookSeries.id, name: bookSeries.name, createdAt: bookSeries.createdAt, updatedAt: bookSeries.updatedAt })
      .from(bookSeries)
      .where(and(accentInsensitiveIlike(bookSeries.name, buildSearchPattern(term)), visible))
      .orderBy(asc(sql`lower(${bookSeries.name})`), asc(bookSeries.id))
      .limit(limit);
  }

  /** Authors of books visible through `bookScope`, with how many of those books each has. */
  async findAuthorsPage(
    bookScope: SQL | undefined,
    options: { limit: number; offset: number; sort: AbsAuthorSort; descending: boolean; term?: string },
  ): Promise<{ rows: AbsAuthorRow[]; total: number }> {
    const where = and(bookScope, options.term ? accentInsensitiveIlike(authors.name, buildSearchPattern(options.term)) : undefined);
    const numBooks = sql<number>`count(distinct ${books.id})::int`;
    const direction = options.descending ? desc : asc;
    const order = options.sort === 'numBooks' ? [direction(numBooks), asc(sql`lower(${authors.name})`)] : [direction(sql`lower(${authors.name})`)];
    const [rows, [count]] = await Promise.all([
      this.db
        .select({ id: authors.id, name: authors.name, description: authors.description, hasPhoto: authors.hasPhoto, numBooks })
        .from(authors)
        .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
        .innerJoin(books, eq(books.id, bookAuthors.bookId))
        .where(where)
        .groupBy(authors.id)
        .orderBy(...order, asc(authors.id))
        .limit(options.limit)
        .offset(options.offset),
      this.db
        .select({ total: sql<number>`count(distinct ${authors.id})::int` })
        .from(authors)
        .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
        .innerJoin(books, eq(books.id, bookAuthors.bookId))
        .where(where),
    ]);
    return { rows, total: count?.total ?? 0 };
  }

  async findAuthorById(authorId: number): Promise<{ id: number; name: string; description: string | null; hasPhoto: boolean } | null> {
    const [row] = await this.db
      .select({ id: authors.id, name: authors.name, description: authors.description, hasPhoto: authors.hasPhoto })
      .from(authors)
      .where(eq(authors.id, authorId))
      .limit(1);
    return row ?? null;
  }

  /** Where clause on `books` matching members of a series, for the ABS `filter=series.<id>` listing. */
  seriesMembershipFilter(seriesId: number): SQL {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(bookSeriesMemberships)
        .where(and(eq(bookSeriesMemberships.bookId, books.id), eq(bookSeriesMemberships.seriesId, seriesId))),
    );
  }

  /** Where clause on `books` matching books by one author, for the ABS `filter=authors.<id>` listing. */
  authorMembershipFilter(authorId: number): SQL {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(bookAuthors)
        .where(and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.authorId, authorId))),
    );
  }

  /** The user's own audiobook bookmarks across books, newest first, for the ABS user object. */
  async findUserAudioBookmarks(
    userId: number,
    limit: number,
  ): Promise<Array<{ bookId: number; title: string; positionSeconds: number; createdAt: Date }>> {
    const rows = await this.db
      .select({ bookId: bookmarks.bookId, title: bookmarks.title, positionSeconds: bookmarks.positionSeconds, createdAt: bookmarks.createdAt })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), isNull(bookmarks.cfi), isNotNull(bookmarks.positionSeconds), isNull(bookmarks.deletedAt)))
      .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
      .limit(limit);
    return rows.map((row) => ({ ...row, positionSeconds: row.positionSeconds ?? 0 }));
  }
}
