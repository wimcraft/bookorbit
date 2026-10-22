import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AudiobookBookmark } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookService } from '../../audiobook/audiobook.service';
import { ABS_MAX_BOOKMARKS } from '../abs-compat.constants';
import { AbsCompatRepository } from '../abs-compat.repository';
import type { AbsAudioBookmark } from '../abs-compat.types';
import { decodeItemId, encodeItemId } from '../abs-ids';
import { asRecord, readFiniteNumber, readString } from '../abs-request';

// Bookmarks are keyed by exact time in ABS. Positions are stored as single-precision reals here, which
// can move a time by a few hundredths of a second deep into a long book; this absorbs only that.
const TIME_MATCH_TOLERANCE_SECONDS = 0.05;
const MAX_TITLE_LENGTH = 500;

function toAbsBookmark(bookId: number, bookmark: Pick<AudiobookBookmark, 'title' | 'positionMs' | 'createdAt'>): AbsAudioBookmark {
  return {
    libraryItemId: encodeItemId(bookId),
    title: bookmark.title,
    time: bookmark.positionMs / 1000,
    createdAt: new Date(bookmark.createdAt).getTime(),
  };
}

function readBookmarkBody(body: unknown): { time: number; title: string } {
  const source = asRecord(body);
  const time = readFiniteNumber(source, 'time');
  const title = readString(source, 'title')?.trim();
  if (time === undefined || time < 0) throw new BadRequestException('Invalid time');
  if (!title) throw new BadRequestException('Invalid title');
  return { time, title: title.slice(0, MAX_TITLE_LENGTH) };
}

/** ABS bookmarks are keyed by item and time; BookOrbit audio bookmarks by a client id. This maps one onto the other. */
@Injectable()
export class AbsBookmarkService {
  constructor(
    private readonly audiobookService: AudiobookService,
    private readonly repo: AbsCompatRepository,
  ) {}

  async listForUser(user: RequestUser): Promise<AbsAudioBookmark[]> {
    const rows = await this.repo.findUserAudioBookmarks(user.id, ABS_MAX_BOOKMARKS);
    return rows.map((row) => ({
      libraryItemId: encodeItemId(row.bookId),
      title: row.title,
      time: row.positionSeconds,
      createdAt: row.createdAt.getTime(),
    }));
  }

  /** Creating at a time that already holds a bookmark renames it, as ABS does, rather than adding a second one. */
  async create(user: RequestUser, itemRef: unknown, body: unknown): Promise<AbsAudioBookmark> {
    const bookId = decodeItemId(itemRef);
    const { time, title } = readBookmarkBody(body);
    const existing = await this.findByTime(user, bookId, time);
    if (existing) {
      const updated = existing.title === title ? existing : await this.audiobookService.updateBookmark(bookId, existing.id, { title }, user);
      return toAbsBookmark(bookId, updated);
    }
    const created = await this.audiobookService.createBookmark(bookId, { clientId: randomUUID(), positionMs: Math.round(time * 1000), title }, user);
    return toAbsBookmark(bookId, created);
  }

  async update(user: RequestUser, itemRef: unknown, body: unknown): Promise<AbsAudioBookmark> {
    const bookId = decodeItemId(itemRef);
    const { time, title } = readBookmarkBody(body);
    const existing = await this.findByTime(user, bookId, time);
    if (!existing) throw new NotFoundException('Bookmark not found');
    return toAbsBookmark(bookId, await this.audiobookService.updateBookmark(bookId, existing.id, { title }, user));
  }

  async remove(user: RequestUser, itemRef: unknown, rawTime: string): Promise<void> {
    const bookId = decodeItemId(itemRef);
    const time = Number(rawTime);
    if (!Number.isFinite(time)) throw new BadRequestException('Invalid time');
    const existing = await this.findByTime(user, bookId, time);
    if (!existing) throw new NotFoundException('Bookmark not found');
    await this.audiobookService.deleteBookmark(bookId, existing.id, user);
  }

  private async findByTime(user: RequestUser, bookId: number, time: number): Promise<AudiobookBookmark | null> {
    const bookmarks = await this.audiobookService.listBookmarks(bookId, user);
    let best: AudiobookBookmark | null = null;
    for (const bookmark of bookmarks) {
      const distance = Math.abs(bookmark.positionMs / 1000 - time);
      if (distance <= TIME_MATCH_TOLERANCE_SECONDS && (!best || distance < Math.abs(best.positionMs / 1000 - time))) best = bookmark;
    }
    return best;
  }
}
