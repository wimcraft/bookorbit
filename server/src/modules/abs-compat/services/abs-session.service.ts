import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../../common/types/request-user';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { AudiobookService } from '../../audiobook/audiobook.service';
import { ABS_MAX_LOCAL_SESSIONS } from '../abs-compat.constants';
import type { AbsLocalSessionResult } from '../abs-compat.types';
import { decodeItemId, decodePlaybackSessionBookId } from '../abs-ids';
import { asRecord, readFiniteNumber, readString, requireFiniteNumber } from '../abs-request';

const MAX_LOCAL_SESSION_ENTRIES = 5000;
const MEDIA_ITEM_NOT_FOUND = 'Media item not found';

interface LocalSessionInput {
  id: string;
  libraryItemId: unknown;
  currentTimeSeconds: number | undefined;
  updatedAtMs: number | undefined;
}

export interface LocalSessionBatchSummary {
  results: AbsLocalSessionResult[];
  applied: number;
  skippedOlder: number;
  failed: number;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'Error';
}

function errorMessage(error: unknown): string {
  return sanitizeLogValue(error instanceof Error ? error.message : error);
}

@Injectable()
export class AbsSessionService {
  private readonly logger = new Logger(AbsSessionService.name);

  constructor(private readonly audiobookService: AudiobookService) {}

  /** Live listening: the position is stamped with the server clock, as ABS stamps a streaming sync. */
  async sync(user: RequestUser, sessionId: string, body: unknown): Promise<void> {
    const bookId = decodePlaybackSessionBookId(sessionId);
    const currentTime = requireFiniteNumber(asRecord(body), 'currentTime');
    await this.applyAt(user, bookId, currentTime, new Date());
  }

  async close(user: RequestUser, sessionId: string, body: unknown): Promise<void> {
    const bookId = decodePlaybackSessionBookId(sessionId);
    const currentTime = readFiniteNumber(asRecord(body), 'currentTime');
    if (currentTime === undefined) return;
    await this.applyAt(user, bookId, currentTime, new Date());
  }

  /** ABS keeps no session after a restart either, so an open session can never be read back. */
  getOpenSession(): never {
    throw new NotFoundException('Session not found');
  }

  async syncLocal(user: RequestUser, body: unknown): Promise<AbsLocalSessionResult> {
    const summary = await this.syncLocalSessions(user, [body]);
    const result = summary.results[0]!;
    if (!result.success) {
      if (result.error === MEDIA_ITEM_NOT_FOUND) throw new NotFoundException(result.error);
      throw new BadRequestException(result.error ?? 'Session sync failed');
    }
    return result;
  }

  async syncLocalAll(user: RequestUser, body: unknown): Promise<{ results: AbsLocalSessionResult[] }> {
    const sessions = asRecord(body).sessions;
    if (!Array.isArray(sessions)) throw new BadRequestException('sessions must be an array');
    if (sessions.length > MAX_LOCAL_SESSION_ENTRIES) throw new BadRequestException(`At most ${MAX_LOCAL_SESSION_ENTRIES} sessions per request`);
    const { results } = await this.syncLocalSessions(user, sessions);
    return { results };
  }

  /**
   * Offline sessions arrive in bulk and carry the time the listening happened. Only the newest session
   * per book can change the stored position, so older ones for the same book are answered as already
   * synced without a write; this keeps one request bounded by the number of distinct books.
   */
  async syncLocalSessions(user: RequestUser, rawSessions: unknown[]): Promise<LocalSessionBatchSummary> {
    const started = Date.now();
    this.logger.log(`[abs.session_sync_local] [start] userId=${user.id} sessions=${rawSessions.length} - local session sync started`);
    try {
      const inputs = rawSessions.map((raw, index) => this.parseLocalSession(raw, index));
      const resolved = inputs.map((input) => ({ input, bookId: this.tryDecodeItem(input.libraryItemId) }));

      const newestByBook = new Map<number, LocalSessionInput>();
      for (const { input, bookId } of resolved) {
        if (bookId === null || input.currentTimeSeconds === undefined) continue;
        const current = newestByBook.get(bookId);
        if (!current || (input.updatedAtMs ?? 0) >= (current.updatedAtMs ?? 0)) newestByBook.set(bookId, input);
      }

      const now = Date.now();
      const outcomes = new Map<number, AbsLocalSessionResult | 'applied' | 'skippedOlder'>();
      let distinct = 0;
      for (const [bookId, input] of newestByBook) {
        distinct += 1;
        if (distinct > ABS_MAX_LOCAL_SESSIONS) {
          outcomes.set(bookId, { id: input.id, success: false, error: 'Too many sessions in one request' });
          continue;
        }
        outcomes.set(bookId, await this.applyLocal(user, bookId, input, now));
      }

      let applied = 0;
      let skippedOlder = 0;
      let failed = 0;
      const results = resolved.map<AbsLocalSessionResult>(({ input, bookId }) => {
        if (bookId === null) {
          failed += 1;
          return { id: input.id, success: false, error: MEDIA_ITEM_NOT_FOUND };
        }
        if (input.currentTimeSeconds === undefined) {
          failed += 1;
          return { id: input.id, success: false, error: 'currentTime is required' };
        }
        const outcome = outcomes.get(bookId)!;
        if (newestByBook.get(bookId) !== input) {
          skippedOlder += 1;
          return { id: input.id, success: true, progressSynced: false };
        }
        if (outcome === 'applied') {
          applied += 1;
          return { id: input.id, success: true, progressSynced: true };
        }
        if (outcome === 'skippedOlder') {
          skippedOlder += 1;
          return { id: input.id, success: true, progressSynced: false };
        }
        failed += 1;
        return outcome;
      });

      this.logger.log(
        `[abs.session_sync_local] [end] userId=${user.id} sessions=${rawSessions.length} applied=${applied} skippedOlder=${skippedOlder} failed=${failed} durationMs=${Date.now() - started} - local session sync completed`,
      );
      return { results, applied, skippedOlder, failed };
    } catch (error) {
      this.logger.warn(
        `[abs.session_sync_local] [fail] userId=${user.id} sessions=${rawSessions.length} durationMs=${Date.now() - started} errorClass=${errorClass(error)} error="${errorMessage(error)}" - local session sync failed`,
      );
      throw error;
    }
  }

  private async applyLocal(
    user: RequestUser,
    bookId: number,
    input: LocalSessionInput,
    now: number,
  ): Promise<AbsLocalSessionResult | 'applied' | 'skippedOlder'> {
    const updatedAt = input.updatedAtMs !== undefined && input.updatedAtMs > 0 ? Math.min(input.updatedAtMs, now) : now;
    try {
      const result = await this.audiobookService.applyExternalPosition(bookId, user, {
        absolutePositionMs: Math.max(0, input.currentTimeSeconds!) * 1000,
        capturedAt: new Date(updatedAt),
      });
      return result.applied ? 'applied' : 'skippedOlder';
    } catch (error) {
      if (error instanceof NotFoundException) return { id: input.id, success: false, error: MEDIA_ITEM_NOT_FOUND };
      this.logger.warn(
        `[abs.session_sync_local] [fail] userId=${user.id} bookId=${bookId} errorClass=${errorClass(error)} error="${errorMessage(error)}" - local session entry failed`,
      );
      return { id: input.id, success: false, error: 'Failed to sync session' };
    }
  }

  private async applyAt(user: RequestUser, bookId: number, currentTimeSeconds: number, capturedAt: Date): Promise<void> {
    try {
      await this.audiobookService.applyExternalPosition(bookId, user, { absolutePositionMs: Math.max(0, currentTimeSeconds) * 1000, capturedAt });
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        this.logger.warn(
          `[abs.session_sync] [fail] userId=${user.id} bookId=${bookId} errorClass=${errorClass(error)} error="${errorMessage(error)}" - session sync failed`,
        );
      }
      throw error;
    }
  }

  private parseLocalSession(raw: unknown, index: number): LocalSessionInput {
    const source = asRecord(raw);
    return {
      id: readString(source, 'id') ?? `unknown-${index}`,
      libraryItemId: source.libraryItemId,
      currentTimeSeconds: readFiniteNumber(source, 'currentTime'),
      updatedAtMs: readFiniteNumber(source, 'updatedAt'),
    };
  }

  private tryDecodeItem(value: unknown): number | null {
    try {
      return decodeItemId(value);
    } catch {
      return null;
    }
  }
}
