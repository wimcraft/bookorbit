import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { BadRequestException, ConflictException, Injectable, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import {
  AUDIOBOOK_MANIFEST_SCHEMA,
  AUDIOBOOK_MANIFEST_VERSION,
  isAudioFormat,
  type AudiobookBookmark,
  type AudiobookManifest,
  type AudiobookManifestAsset,
  type AudiobookManifestChapter,
  type AudiobookPlaybackState,
} from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { compareAudioTracks } from '../../common/utils/book-media.utils';
import type { BookmarkRow } from '../../db/schema';
import { BookService } from '../book/book.service';
import type { CreateAudiobookBookmarkDto } from './dto/create-audiobook-bookmark.dto';
import type { PutAudiobookPlaybackStateDto } from './dto/put-audiobook-playback-state.dto';
import type { UpdateAudiobookBookmarkDto } from './dto/update-audiobook-bookmark.dto';
import { AudiobookRepository } from './audiobook.repository';

type AudioFileRow = Awaited<ReturnType<AudiobookRepository['findAudioFiles']>>[number];
type PlaybackStateRow = NonNullable<Awaited<ReturnType<AudiobookRepository['findPlaybackState']>>>;

// Durations are stored as whole seconds, so a real position can sit up to half a second past the
// rounded duration. Accept a little beyond it and clamp, rather than refusing the tail of a track.
const DURATION_SLACK_MS = 1_000;

interface ManifestContext {
  manifest: AudiobookManifest;
  files: AudioFileRow[];
  libraryId: number;
  hasCompleteDurations: boolean;
}

@Injectable()
export class AudiobookService {
  constructor(
    private readonly repo: AudiobookRepository,
    private readonly bookService: BookService,
  ) {}

  async getManifest(bookId: number, user: RequestUser): Promise<AudiobookManifest> {
    return (await this.loadManifestContext(bookId, user)).manifest;
  }

  async getAsset(bookId: number, assetId: string, user: RequestUser) {
    await this.bookService.verifyBookAccess(bookId, user);
    const row = await this.repo.findAsset(bookId, this.publicIdFromAssetId(assetId));
    if (!row || !row.format || !isAudioFormat(row.format)) throw new NotFoundException('Audiobook asset not found');
    const file = await this.bookService.getFileInfo(row.id, user);
    return {
      absolutePath: file.path,
      format: file.format,
      sizeBytes: file.size,
    };
  }

  async getPlaybackState(bookId: number, user: RequestUser): Promise<AudiobookPlaybackState | null> {
    const context = await this.loadManifestContext(bookId, user);
    const row = await this.repo.findPlaybackState(user.id, bookId);
    return row ? this.mapPlaybackState(context, row) : null;
  }

  /**
   * Applies a position reported by a client that does not speak the manifest protocol, in absolute
   * milliseconds from the start of the book. The write only lands when it describes listening at or
   * after the stored `capturedAt`, so an offline session uploaded late cannot overwrite newer progress
   * from another device. A timestamp from the future is clamped to now so a skewed clock cannot pin
   * progress forever.
   */
  async applyExternalPosition(
    bookId: number,
    user: RequestUser,
    input: { absolutePositionMs: number; capturedAt: Date; finished?: boolean },
  ): Promise<{ applied: boolean; state: AudiobookPlaybackState | null }> {
    const context = await this.loadManifestContext(bookId, user);
    const now = Date.now();
    const capturedAtMs = Number.isFinite(input.capturedAt.getTime()) ? Math.min(input.capturedAt.getTime(), now) : now;
    const target = this.locateAbsolutePosition(context, input.finished ? context.manifest.totalDurationMs : input.absolutePositionMs);

    for (let attempt = 0; ; attempt += 1) {
      const current = await this.repo.findPlaybackState(user.id, bookId);
      if (current) {
        const currentMs = current.capturedAt.getTime();
        const samePosition =
          current.currentFileId === context.files[target.assetIndex]!.id && Math.abs(current.positionSeconds * 1000 - target.positionMs) < 1;
        if (currentMs > capturedAtMs || (currentMs === capturedAtMs && samePosition)) {
          return { applied: false, state: this.mapPlaybackState(context, current) };
        }
      }
      try {
        const state = await this.putPlaybackState(
          bookId,
          {
            assetId: context.manifest.assets[target.assetIndex]!.assetId,
            positionMs: target.positionMs,
            capturedAt: new Date(capturedAtMs).toISOString(),
            operationId: randomUUID(),
            baseRevision: current?.revision ?? 0,
            manifestRevision: context.manifest.revision,
          },
          user,
          context,
        );
        return { applied: true, state };
      } catch (error) {
        if (!(error instanceof ConflictException) || attempt >= 1) throw error;
      }
    }
  }

  async putPlaybackState(
    bookId: number,
    dto: PutAudiobookPlaybackStateDto,
    user: RequestUser,
    preloaded?: ManifestContext,
  ): Promise<AudiobookPlaybackState> {
    const context = preloaded ?? (await this.loadManifestContext(bookId, user));
    if (dto.manifestRevision !== context.manifest.revision) {
      throw new PreconditionFailedException('Audiobook manifest has changed');
    }
    const fileIndex = context.files.findIndex((file) => this.assetId(file.publicId) === dto.assetId);
    if (fileIndex < 0) throw new BadRequestException('assetId does not belong to this audiobook');

    const previous = await this.repo.findPlaybackState(user.id, bookId);
    if (previous?.operationId === dto.operationId) {
      const existing = (await this.getPlaybackState(bookId, user))!;
      await this.bookService.syncEbookProgressForAudiobookPlayback(
        user,
        bookId,
        previous.currentFileId,
        previous.positionSeconds,
        previous.percentage,
        previous.capturedAt,
      );
      return existing;
    }

    const asset = context.manifest.assets[fileIndex]!;
    if (asset.durationMs !== null && dto.positionMs > asset.durationMs + DURATION_SLACK_MS) {
      throw new BadRequestException('positionMs exceeds the asset duration');
    }
    const positionMs = asset.durationMs === null ? dto.positionMs : Math.min(dto.positionMs, asset.durationMs);
    const elapsedBefore = context.manifest.assets.slice(0, fileIndex).reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    const absolutePositionMs = elapsedBefore + positionMs;
    const percentage =
      context.hasCompleteDurations && context.manifest.totalDurationMs > 0
        ? Math.max(0, Math.min(100, (absolutePositionMs / context.manifest.totalDurationMs) * 100))
        : (previous?.percentage ?? 0);
    const values = {
      currentFileId: context.files[fileIndex]!.id,
      positionSeconds: positionMs / 1000,
      percentage,
      capturedAt: new Date(dto.capturedAt),
      operationId: dto.operationId,
      manifestRevision: dto.manifestRevision,
    };
    const saved =
      dto.baseRevision === 0
        ? await this.repo.createPlaybackState(user.id, bookId, values)
        : await this.repo.updatePlaybackState(user.id, bookId, dto.baseRevision, values);
    if (!saved) throw new ConflictException('Playback state revision conflict');

    const strongRereadEvidence = previous !== null && previous.percentage - percentage >= 10;
    await this.bookService.autoUpdateReadStatusForProgress(
      user.id,
      { bookId, libraryId: context.libraryId },
      percentage,
      strongRereadEvidence ? { origin: 'bookorbit', strongRereadEvidence: true } : {},
    );
    await this.bookService.syncEbookProgressForAudiobookPlayback(
      user,
      bookId,
      values.currentFileId,
      values.positionSeconds,
      percentage,
      saved.capturedAt,
    );
    return {
      assetId: dto.assetId,
      positionMs,
      percentage,
      completed: percentage >= 100,
      capturedAt: saved.capturedAt.toISOString(),
      revision: saved.revision,
      manifestRevision: dto.manifestRevision,
    };
  }

  async deletePlaybackState(bookId: number, user: RequestUser): Promise<void> {
    await this.bookService.verifyBookAccess(bookId, user);
    await this.repo.deletePlaybackState(user.id, bookId);
  }

  async listBookmarks(bookId: number, user: RequestUser): Promise<AudiobookBookmark[]> {
    await this.bookService.verifyBookAccess(bookId, user);
    const rows = await this.repo.findAudioBookmarks(user.id, bookId);
    return rows.map((row) => this.mapBookmark(row));
  }

  async createBookmark(bookId: number, dto: CreateAudiobookBookmarkDto, user: RequestUser): Promise<AudiobookBookmark> {
    const context = await this.loadManifestContext(bookId, user);
    const totalDurationMs = context.manifest.totalDurationMs;
    if (totalDurationMs > 0 && dto.positionMs > totalDurationMs + DURATION_SLACK_MS) {
      throw new BadRequestException('positionMs exceeds the audiobook duration');
    }
    if (dto.chapterId && !context.manifest.chapters.some((chapter) => chapter.id === dto.chapterId)) {
      throw new BadRequestException('chapterId does not belong to this audiobook manifest');
    }
    const row = await this.repo.createAudioBookmark(user.id, bookId, {
      clientId: dto.clientId,
      positionSeconds: (totalDurationMs > 0 ? Math.min(dto.positionMs, totalDurationMs) : dto.positionMs) / 1000,
      chapterId: dto.chapterId ?? null,
      title: dto.title,
      note: dto.note ?? null,
    });
    if (!row) throw new ConflictException('Audiobook bookmark already exists');
    return this.mapBookmark(row);
  }

  async updateBookmark(bookId: number, bookmarkId: string, dto: UpdateAudiobookBookmarkDto, user: RequestUser): Promise<AudiobookBookmark> {
    await this.bookService.verifyBookAccess(bookId, user);
    if (dto.title === undefined && dto.note === undefined) {
      throw new BadRequestException('At least one bookmark field is required');
    }
    const row = await this.repo.updateAudioBookmark(user.id, bookId, bookmarkId, dto);
    if (!row) throw new NotFoundException('Audiobook bookmark not found');
    return this.mapBookmark(row);
  }

  async deleteBookmark(bookId: number, bookmarkId: string, user: RequestUser): Promise<void> {
    await this.bookService.verifyBookAccess(bookId, user);
    if (!(await this.repo.deleteAudioBookmark(user.id, bookId, bookmarkId))) {
      throw new NotFoundException('Audiobook bookmark not found');
    }
  }

  private mapPlaybackState(context: ManifestContext, row: PlaybackStateRow): AudiobookPlaybackState | null {
    const file = context.files.find((candidate) => candidate.id === row.currentFileId);
    if (!file) return null;
    return {
      assetId: this.assetId(file.publicId),
      positionMs: Math.max(0, Math.round(row.positionSeconds * 1000)),
      percentage: row.percentage,
      completed: row.percentage >= 100,
      capturedAt: row.capturedAt.toISOString(),
      revision: row.revision,
      manifestRevision: row.manifestRevision ?? context.manifest.revision,
    };
  }

  /**
   * Maps an absolute position to the asset that plays it. A position on the boundary between two
   * assets belongs to the start of the later one; only the end of the book stays on the last asset.
   */
  private locateAbsolutePosition(context: ManifestContext, absolutePositionMs: number): { assetIndex: number; positionMs: number } {
    const { assets, totalDurationMs } = context.manifest;
    const clamped = Math.max(0, Math.min(Number.isFinite(absolutePositionMs) ? Math.round(absolutePositionMs) : 0, totalDurationMs));
    let elapsed = 0;
    for (let index = 0; index < assets.length; index += 1) {
      const duration = assets[index]!.durationMs ?? 0;
      const isLast = index === assets.length - 1;
      if (isLast || clamped < elapsed + duration) {
        const offset = Math.max(0, clamped - elapsed);
        return { assetIndex: index, positionMs: assets[index]!.durationMs === null ? offset : Math.min(offset, duration) };
      }
      elapsed += duration;
    }
    return { assetIndex: 0, positionMs: 0 };
  }

  private async loadManifestContext(bookId: number, user: RequestUser): Promise<ManifestContext> {
    await this.bookService.verifyBookAccess(bookId, user);
    const [detail, rows] = await Promise.all([this.bookService.getDetail(bookId, user), this.repo.findAudioFiles(bookId)]);
    const files = rows.filter((row) => row.format !== null && isAudioFormat(row.format)).sort(compareAudioTracks);
    if (files.length === 0) throw new NotFoundException('Book has no audiobook assets');

    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          files: files.map((file) => [file.publicId, file.sizeBytes, file.durationSeconds, file.mtime?.toISOString(), file.updatedAt.toISOString()]),
          chapters: detail.audioMetadata?.chapters ?? [],
        }),
      )
      .digest('hex');
    const assets = files.map<AudiobookManifestAsset>((file, sequence) => ({
      assetId: this.assetId(file.publicId),
      fileId: file.id,
      sequence,
      format: file.format!,
      durationMs: file.durationSeconds === null ? null : Math.round(file.durationSeconds * 1000),
      sizeBytes: file.sizeBytes,
      etag: createHash('sha256')
        .update(`${file.publicId}:${file.sizeBytes ?? ''}:${file.mtime?.getTime() ?? ''}`)
        .digest('hex'),
    }));
    const hasCompleteDurations = assets.every((asset) => asset.durationMs !== null && asset.durationMs > 0);
    const measuredDurationMs = assets.reduce((sum, asset) => sum + (asset.durationMs ?? 0), 0);
    const totalDurationMs = hasCompleteDurations
      ? measuredDurationMs
      : detail.audioMetadata?.durationSeconds !== null && detail.audioMetadata?.durationSeconds !== undefined
        ? Math.round(detail.audioMetadata.durationSeconds * 1000)
        : measuredDurationMs;
    const chapters = this.buildChapters(bookId, revision, detail.audioMetadata?.chapters ?? [], assets, totalDurationMs);
    return {
      libraryId: detail.libraryId,
      files,
      hasCompleteDurations,
      manifest: {
        schema: AUDIOBOOK_MANIFEST_SCHEMA,
        schemaVersion: AUDIOBOOK_MANIFEST_VERSION,
        revision,
        book: {
          id: bookId,
          title: detail.title ?? basename(detail.folderPath),
          authors: detail.authors.map((author) => author.name),
          narrators: detail.audioMetadata?.narrators.map((narrator) => narrator.name) ?? [],
          hasCover: detail.coverSource !== null,
        },
        assets,
        chapters,
        totalDurationMs,
      },
    };
  }

  private buildChapters(
    bookId: number,
    revision: string,
    chapters: { title: string; startMs: number }[],
    assets: AudiobookManifestAsset[],
    totalDurationMs: number,
  ): AudiobookManifestChapter[] {
    return [...chapters]
      .sort((left, right) => left.startMs - right.startMs)
      .map((chapter, sequence, ordered) => {
        const startMs = Math.max(0, Math.round(chapter.startMs));
        const endMs = Math.max(startMs, Math.round(ordered[sequence + 1]?.startMs ?? totalDurationMs));
        let elapsed = 0;
        let assetIndex = 0;
        for (let index = 0; index < assets.length; index += 1) {
          const duration = assets[index]!.durationMs ?? 0;
          if (index === assets.length - 1 || startMs < elapsed + duration) {
            assetIndex = index;
            break;
          }
          elapsed += duration;
        }
        return {
          id: `ch_${createHash('sha256').update(`${bookId}:${revision}:${sequence}:${startMs}`).digest('hex').slice(0, 32)}`,
          title: chapter.title,
          assetId: assets[assetIndex]!.assetId,
          sequence,
          startMs,
          endMs,
          assetOffsetMs: Math.max(0, startMs - elapsed),
        };
      });
  }

  private mapBookmark(row: BookmarkRow): AudiobookBookmark {
    return {
      id: row.clientId,
      bookId: row.bookId,
      positionMs: Math.max(0, Math.round((row.positionSeconds ?? 0) * 1000)),
      chapterId: row.chapterId,
      title: row.title,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private assetId(publicId: string): string {
    return `aud_${publicId}`;
  }

  private publicIdFromAssetId(assetId: string): string {
    const publicId = assetId.startsWith('aud_') ? assetId.slice(4) : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
      throw new NotFoundException('Audiobook asset not found');
    }
    return publicId;
  }
}
