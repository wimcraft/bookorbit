import { Inject, Injectable } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import type { AudiobookManifest, AudiobookPlaybackState, BookCard } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { authConfig } from '../../../config/config';
import { AudiobookService } from '../../audiobook/audiobook.service';
import { BookService } from '../../book/book.service';
import { AbsCompatRepository, type AbsItemFacts } from '../abs-compat.repository';
import type { AbsLibraryItemExpanded, AbsLibraryItemMinified, AbsPlaybackSession } from '../abs-compat.types';
import { decodeItemId, encodePlaybackSessionId } from '../abs-ids';
import { asRecord, readString } from '../abs-request';
import { toAbsDeviceInfo, toAbsPlaybackSession } from '../serializers/session.serializer';
import {
  toLibraryItemExpanded,
  toLibraryItemMinified,
  type AbsAudioFileSource,
  type AbsBookInfo,
  type AbsItemStats,
} from '../serializers/item.serializer';

export function itemDurationSeconds(facts: Pick<AbsItemFacts, 'durationSeconds' | 'missingDurations' | 'fileCount' | 'metaDurationSeconds'>): number {
  const complete = facts.fileCount > 0 && facts.missingDurations === 0;
  return complete ? facts.durationSeconds : (facts.metaDurationSeconds ?? facts.durationSeconds);
}

export function statsFromFacts(facts: AbsItemFacts): AbsItemStats {
  return {
    folderPath: facts.folderPath,
    folderRoot: facts.folderRoot,
    fileCount: facts.fileCount,
    sizeBytes: facts.sizeBytes,
    durationSeconds: itemDurationSeconds(facts),
    chapterCount: facts.chapterCount,
  };
}

export function bookInfoFromCard(card: BookCard, libraryId: number): AbsBookInfo {
  return {
    id: card.id,
    libraryId,
    title: card.title ?? '',
    subtitle: card.subtitle,
    authors: card.authors.map((name) => ({ id: null, name })),
    narrators: card.narrators,
    series: card.seriesName ? [{ id: card.seriesId ?? null, name: card.seriesName, sequence: card.seriesIndex }] : [],
    genres: card.genres,
    tags: card.tags,
    publishedYear: card.publishedYear,
    publishedDate: card.publishedDate,
    publisher: card.publisher,
    language: card.language,
    description: null,
    isbn: card.isbn13,
    asin: null,
    abridged: false,
    hasCover: card.hasCover,
    addedAt: card.addedAt,
    updatedAt: card.updatedAt,
  };
}

type BookDetailResult = Awaited<ReturnType<BookService['getDetail']>>;

export function bookInfoFromDetail(detail: BookDetailResult): AbsBookInfo {
  const memberships = detail.seriesMemberships ?? [];
  const series =
    memberships.length > 0
      ? memberships.map((entry) => ({ id: entry.seriesId, name: entry.seriesName, sequence: entry.seriesIndex }))
      : detail.seriesName
        ? [{ id: detail.seriesId ?? null, name: detail.seriesName, sequence: detail.seriesIndex }]
        : [];
  return {
    id: detail.id,
    libraryId: detail.libraryId,
    title: detail.title ?? '',
    subtitle: detail.subtitle,
    authors: detail.authors.map((author) => ({ id: author.id, name: author.name })),
    narrators: detail.audioMetadata?.narrators.map((narrator) => narrator.name) ?? [],
    series,
    genres: detail.genres,
    tags: detail.tags,
    publishedYear: detail.publishedYear,
    publishedDate: detail.publishedDate,
    publisher: detail.publisher,
    language: detail.language,
    description: detail.description,
    isbn: detail.isbn13 ?? detail.isbn10,
    asin: detail.providerIds?.audible ?? null,
    abridged: detail.audioMetadata?.abridged ?? false,
    hasCover: detail.coverSource !== null,
    addedAt: detail.addedAt,
    updatedAt: detail.updatedAt,
  };
}

/** Absolute position in seconds that a stored playback state points at; 0 when it is finished so a replay starts over. */
export function startTimeSeconds(manifest: AudiobookManifest, state: AudiobookPlaybackState | null): number {
  if (!state || state.completed) return 0;
  let elapsedMs = 0;
  for (const asset of manifest.assets) {
    if (asset.assetId === state.assetId) return (elapsedMs + state.positionMs) / 1000;
    elapsedMs += asset.durationMs ?? 0;
  }
  return 0;
}

@Injectable()
export class AbsItemService {
  constructor(
    private readonly repo: AbsCompatRepository,
    private readonly audiobookService: AudiobookService,
    private readonly bookService: BookService,
    @Inject(authConfig.KEY) private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  /** Converts a page of cards with a single facts query for the whole page. */
  async minifyCards(cards: BookCard[]): Promise<AbsLibraryItemMinified[]> {
    const facts = await this.repo.findItemFacts(cards.map((card) => card.id));
    return cards.flatMap((card) => {
      const cardFacts = facts.get(card.id);
      if (!cardFacts || cardFacts.fileCount === 0) return [];
      return [toLibraryItemMinified(bookInfoFromCard(card, cardFacts.libraryId), statsFromFacts(cardFacts))];
    });
  }

  async getExpanded(user: RequestUser, itemId: unknown): Promise<AbsLibraryItemExpanded> {
    const bookId = decodeItemId(itemId);
    const { expanded } = await this.buildExpanded(user, bookId);
    return expanded;
  }

  async play(user: RequestUser, itemId: unknown, body: unknown): Promise<AbsPlaybackSession> {
    const bookId = decodeItemId(itemId);
    const request = asRecord(body);
    const { expanded, manifest } = await this.buildExpanded(user, bookId);
    const state = await this.audiobookService.getPlaybackState(bookId, user);
    const sessionId = encodePlaybackSessionId(this.auth.jwtSecret, {
      bookId,
      userId: user.id,
      authSessionId: user.sessionId ?? 0,
      authMethod: user.authenticationMethod ?? 'legacy',
    });
    return toAbsPlaybackSession({
      sessionId,
      userId: user.id,
      item: expanded,
      bookId,
      currentTimeSeconds: startTimeSeconds(manifest, state),
      deviceInfo: toAbsDeviceInfo(request.deviceInfo, 'Audiobookshelf client'),
      mediaPlayer: readString(request, 'mediaPlayer') ?? 'unknown',
    });
  }

  private async buildExpanded(user: RequestUser, bookId: number) {
    const manifest = await this.audiobookService.getManifest(bookId, user);
    const [detail, files, facts] = await Promise.all([
      this.bookService.getDetail(bookId, user),
      this.repo.findAudioFileDetails(bookId),
      this.repo.findItemFacts([bookId]),
    ]);
    const itemFacts = facts.get(bookId);
    const stats = itemFacts
      ? statsFromFacts(itemFacts)
      : {
          folderPath: detail.folderPath,
          folderRoot: detail.folderPath,
          fileCount: manifest.assets.length,
          sizeBytes: 0,
          durationSeconds: 0,
          chapterCount: 0,
        };
    const sources: AbsAudioFileSource[] = files.map((file) => ({
      fileId: file.id,
      publicId: file.publicId,
      absolutePath: file.absolutePath,
      relPath: file.relPath,
      sizeBytes: file.sizeBytes,
      mtime: file.mtime,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    }));
    const expanded = toLibraryItemExpanded(bookInfoFromDetail(detail), stats, manifest, sources);
    return { expanded, manifest };
  }
}
