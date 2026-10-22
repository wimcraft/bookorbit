import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../../common/types/request-user';
import { compareAudioTracks } from '../../../common/utils/book-media.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { AudiobookService } from '../../audiobook/audiobook.service';
import { LibraryService } from '../../library/library.service';
import { ABS_MAX_MEDIA_PROGRESS } from '../abs-compat.constants';
import { AbsCompatRepository, type AbsProgressRow, type AbsTimelineFileRow } from '../abs-compat.repository';
import type { AbsMediaProgress } from '../abs-compat.types';
import { decodeProgressReference } from '../abs-ids';
import { asRecord, readBoolean, readFiniteNumber } from '../abs-request';
import { absoluteSeconds, buildTimeline } from '../serializers/book-timeline';
import { toAbsMediaProgress } from '../serializers/progress.serializer';
import { AbsSocketHub } from './abs-socket-hub.service';

export interface ProgressPatch {
  currentTimeSeconds?: number;
  isFinished?: boolean;
  lastUpdateMs?: number;
}

@Injectable()
export class AbsProgressService {
  private readonly logger = new Logger(AbsProgressService.name);

  constructor(
    private readonly repo: AbsCompatRepository,
    private readonly audiobookService: AudiobookService,
    private readonly libraryService: LibraryService,
    private readonly socketHub: AbsSocketHub,
  ) {}

  /** The user's audiobook progress, newest first and capped, in two queries regardless of how many books. */
  async listForUser(user: RequestUser): Promise<AbsMediaProgress[]> {
    return this.load(user, ABS_MAX_MEDIA_PROGRESS);
  }

  async getOne(user: RequestUser, reference: unknown): Promise<AbsMediaProgress> {
    const bookId = decodeProgressReference(reference);
    const [progress] = await this.load(user, 1, bookId);
    if (!progress) throw new NotFoundException('Progress not found');
    return progress;
  }

  async findForBook(user: RequestUser, bookId: number): Promise<AbsMediaProgress | null> {
    const [progress] = await this.load(user, 1, bookId);
    return progress ?? null;
  }

  parsePatch(body: unknown, now = Date.now()): ProgressPatch {
    const source = asRecord(body);
    const lastUpdate = readFiniteNumber(source, 'lastUpdate');
    return {
      currentTimeSeconds: readFiniteNumber(source, 'currentTime'),
      isFinished: readBoolean(source, 'isFinished'),
      lastUpdateMs: lastUpdate !== undefined && lastUpdate > 0 ? Math.min(lastUpdate, now) : undefined,
    };
  }

  /** Returns whether the stored position changed. */
  async applyPatch(user: RequestUser, bookId: number, patch: ProgressPatch): Promise<boolean> {
    const capturedAt = new Date(patch.lastUpdateMs ?? Date.now());
    if (patch.isFinished === true) {
      const result = await this.audiobookService.applyExternalPosition(bookId, user, { absolutePositionMs: 0, capturedAt, finished: true });
      return result.applied;
    }
    // Un-finishing writes a position instead of deleting it: the drop from 100% is the evidence BookOrbit
    // needs to move a read book to rereading, which a missing row cannot provide.
    const currentTimeSeconds = patch.isFinished === false ? (patch.currentTimeSeconds ?? 0) : patch.currentTimeSeconds;
    if (currentTimeSeconds === undefined) return false;
    const result = await this.audiobookService.applyExternalPosition(bookId, user, {
      absolutePositionMs: Math.max(0, currentTimeSeconds) * 1000,
      capturedAt,
    });
    return result.applied;
  }

  async patchOne(user: RequestUser, reference: unknown, body: unknown): Promise<void> {
    const bookId = decodeProgressReference(reference);
    if (await this.applyPatch(user, bookId, this.parsePatch(body))) await this.publish(user, bookId);
  }

  async patchBatch(user: RequestUser, entries: unknown[]): Promise<{ applied: number; failed: number }> {
    let applied = 0;
    let failed = 0;
    for (const entry of entries) {
      const record = asRecord(entry);
      try {
        const bookId = decodeProgressReference(record.libraryItemId);
        if (await this.applyPatch(user, bookId, this.parsePatch(record))) {
          applied += 1;
          await this.publish(user, bookId);
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `[abs.progress_batch] [fail] userId=${user.id} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - batch entry failed`,
        );
      }
    }
    return { applied, failed };
  }

  async remove(user: RequestUser, reference: unknown): Promise<void> {
    await this.audiobookService.deletePlaybackState(decodeProgressReference(reference), user);
  }

  /**
   * Pushes the stored progress to the user's connected apps, which only refresh their home screen from
   * this event. Best effort: skipped when no app is listening, and a failure never fails the write.
   */
  async publish(user: RequestUser, bookId: number, sessionId: string | null = null): Promise<void> {
    if (!this.socketHub.isListening(user.id)) return;
    try {
      const progress = await this.findForBook(user, bookId);
      if (!progress) return;
      this.socketHub.emitToUser(user.id, 'user_item_progress_updated', { id: progress.id, sessionId, deviceDescription: null, data: progress });
    } catch (error) {
      this.logger.warn(
        `[abs.progress_publish] [fail] userId=${user.id} bookId=${bookId} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - progress event not sent`,
      );
    }
  }

  private async load(user: RequestUser, limit: number, bookId?: number): Promise<AbsMediaProgress[]> {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const rows = await this.repo.findProgressRows(user.id, libraryIds, limit, bookId);
    if (rows.length === 0) return [];
    const files = await this.repo.findTimelineFiles(rows.map((row) => row.bookId));
    const filesByBook = new Map<number, AbsTimelineFileRow[]>();
    for (const file of files) {
      const list = filesByBook.get(file.bookId);
      if (list) list.push(file);
      else filesByBook.set(file.bookId, [file]);
    }
    return rows.flatMap((row) => {
      const progress = this.toProgress(user.id, row, filesByBook.get(row.bookId) ?? []);
      return progress ? [progress] : [];
    });
  }

  private toProgress(userId: number, row: AbsProgressRow, files: AbsTimelineFileRow[]): AbsMediaProgress | null {
    const timeline = buildTimeline(files, compareAudioTracks, row.metaDurationSeconds);
    const currentTime = absoluteSeconds(timeline, row.currentFileId, row.positionSeconds);
    if (currentTime === null) return null;
    return toAbsMediaProgress({
      userId,
      bookId: row.bookId,
      durationSeconds: timeline.totalSeconds,
      currentTimeSeconds: currentTime,
      percentage: row.percentage,
      capturedAt: row.capturedAt,
      readStatus: row.readStatus,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }
}
