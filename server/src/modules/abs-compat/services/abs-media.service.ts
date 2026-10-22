import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';

import type { RequestUser } from '../../../common/types/request-user';
import { compareAudioTracks } from '../../../common/utils/book-media.utils';
import { authConfig } from '../../../config/config';
import { AudiobookService } from '../../audiobook/audiobook.service';
import { BookService } from '../../book/book.service';
import { AuthorImageStorageService } from '../../authors/author-image-storage.service';
import { BookCoverStore } from '../../book-cover-store/book-cover-store.service';
import { AbsCompatRepository } from '../abs-compat.repository';
import { decodeAuthorId, decodeItemId, verifyPlaybackSessionId } from '../abs-ids';
import { AbsAuthService } from './abs-auth.service';

const ANONYMOUS_COVERS_KEY = 'ABS_COMPAT_ANONYMOUS_COVERS';

export interface ResolvedAudioFile {
  absolutePath: string;
  format: string;
  sizeBytes: number;
}

@Injectable()
export class AbsMediaService {
  constructor(
    private readonly audiobookService: AudiobookService,
    private readonly bookService: BookService,
    private readonly coverStore: BookCoverStore,
    private readonly authorImages: AuthorImageStorageService,
    private readonly repo: AbsCompatRepository,
    private readonly authService: AbsAuthService,
    private readonly configService: ConfigService,
    @Inject(authConfig.KEY) private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Official apps request covers with no credentials once the server reports 2.17 or newer, as ABS
   * itself serves them. A request that does carry a user gets the normal access check; one that does
   * not falls back to audiobook covers only, unless ABS_COMPAT_ANONYMOUS_COVERS is switched off.
   */
  async resolveCover(itemRef: unknown, user: RequestUser | null): Promise<string> {
    const bookId = decodeItemId(itemRef);
    let path: string | null;
    if (user) {
      path = await this.bookService.getCoverPath(bookId, user, { medium: 'audio' });
    } else {
      if (!this.anonymousCoversEnabled()) throw new NotFoundException('Cover not found');
      const facts = await this.repo.findItemFacts([bookId]);
      if ((facts.get(bookId)?.fileCount ?? 0) === 0) throw new NotFoundException('Cover not found');
      path = await this.coverStore.resolve(bookId, { variant: 'cover', medium: 'audio' });
    }
    if (!path) throw new NotFoundException('Cover not found');
    return path;
  }

  /** Author photos follow the cover rule: a token is checked when sent, and anonymous requests depend on the same switch. */
  async resolveAuthorImage(authorRef: unknown, user: RequestUser | null): Promise<string> {
    const authorId = decodeAuthorId(authorRef);
    if (!user && !this.anonymousCoversEnabled()) throw new NotFoundException('Image not found');
    const path = await this.authorImages.getImagePath(authorId);
    if (!path) throw new NotFoundException('Image not found');
    return path;
  }

  async resolveFile(user: RequestUser, itemRef: unknown, ino: string): Promise<ResolvedAudioFile> {
    const bookId = decodeItemId(itemRef);
    return this.audiobookService.getAsset(bookId, `aud_${ino}`, user);
  }

  /** The track URL the apps build from a playback session carries no credentials; the signed session id stands in for them. */
  async resolveSessionTrack(sessionId: string, trackIndex: number): Promise<ResolvedAudioFile> {
    const parts = verifyPlaybackSessionId(this.auth.jwtSecret, sessionId);
    const user = await this.authService.verifySessionCapability(parts);
    if (!Number.isInteger(trackIndex) || trackIndex < 1) throw new NotFoundException('Track not found');
    const files = (await this.repo.findTimelineFiles([parts.bookId])).sort(compareAudioTracks);
    const file = files[trackIndex - 1];
    if (!file) throw new NotFoundException('Track not found');
    return this.audiobookService.getAsset(parts.bookId, `aud_${file.publicId}`, user);
  }

  private anonymousCoversEnabled(): boolean {
    const value = this.configService.get<string>(ANONYMOUS_COVERS_KEY);
    return !(typeof value === 'string' && ['false', '0', 'no', 'off'].includes(value.trim().toLowerCase()));
  }
}
