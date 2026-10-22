import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, exists, inArray, ne, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AUDIO_FORMAT_LIST } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { audiobookProgress, bookFiles, bookMetadata, books, libraryFolders, userBookStatus } from '../../db/schema';

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

@Injectable()
export class AbsCompatRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** One query for everything a page of list items needs beyond the book cards. */
  async findItemFacts(bookIds: number[]): Promise<Map<number, AbsItemFacts>> {
    if (bookIds.length === 0) return new Map();
    const audio = this.db
      .select({
        bookId: bookFiles.bookId,
        fileCount: sql<number>`count(*)::int`.as('file_count'),
        sizeBytes: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)::float8`.as('size_bytes'),
        durationSeconds: sql<number>`coalesce(sum(${bookFiles.durationSeconds}), 0)::float8`.as('duration_seconds'),
        missingDurations: sql<number>`(count(*) filter (where ${bookFiles.durationSeconds} is null or ${bookFiles.durationSeconds} = 0))::int`.as(
          'missing_durations',
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
          sql`(${audiobookProgress.percentage} >= 100 or ${userBookStatus.status} = 'read')`,
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
}
