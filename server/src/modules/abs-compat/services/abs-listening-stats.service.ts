import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { ReadingSessionSource } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { compareAudioTracks } from '../../../common/utils/book-media.utils';
import { ReadingSessionService } from '../../reading-session/reading-session.service';
import { AbsCompatRepository } from '../abs-compat.repository';

const MAX_LIVE_SESSIONS = 2000;
const LIVE_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
// A sync reports the seconds since the previous one; more than this in one tick is not real listening.
const MAX_LIVE_DELTA_SECONDS = 600;

interface LiveTotal {
  totalSeconds: number;
  startedAtMs: number;
  lastSeenMs: number;
}

export interface LocalListen {
  sessionId: string;
  bookId: number;
  timeListeningSeconds: number;
  startedAtMs: number | undefined;
  updatedAtMs: number;
}

export function listeningSource(userAgent: string | undefined): ReadingSessionSource {
  const agent = userAgent ?? '';
  if (/okhttp|android|dalvik/i.test(agent)) return 'android';
  if (/soundleaf|ios|iphone|ipad|darwin|cfnetwork/i.test(agent)) return 'ios';
  return 'web';
}

/** ABS session ids can exceed the 64 characters BookOrbit keeps, so stats rows use a stable digest of them. */
export function statsSessionId(absSessionId: string): string {
  return `abs-${createHash('sha256').update(absSessionId).digest('hex').slice(0, 40)}`;
}

/**
 * Records ABS listening time as BookOrbit listen sessions, so it appears in reading statistics. Saving the
 * same session id again only ever raises its duration, which makes every write here safe to repeat.
 * Stats are best effort: a failure is logged and never fails the progress sync that carried it.
 */
@Injectable()
export class AbsListeningStatsService {
  private readonly logger = new Logger(AbsListeningStatsService.name);
  private readonly live = new Map<string, LiveTotal>();

  constructor(
    private readonly readingSessions: ReadingSessionService,
    private readonly repo: AbsCompatRepository,
  ) {}

  /**
   * Streaming syncs carry only the seconds since the previous sync, so a running total is kept per session
   * in memory. After a restart the total starts again from zero and the stored row is not lowered, so a
   * session cut by a restart can be undercounted but never counted twice.
   */
  async recordLive(user: RequestUser, absSessionId: string, bookId: number, timeListenedSeconds: number | undefined, source: ReadingSessionSource) {
    if (timeListenedSeconds === undefined || timeListenedSeconds <= 0) return;
    const now = Date.now();
    const delta = Math.min(timeListenedSeconds, MAX_LIVE_DELTA_SECONDS);
    const key = `${user.id}:${absSessionId}`;
    const current = this.live.get(key);
    const total: LiveTotal = current
      ? { totalSeconds: current.totalSeconds + delta, startedAtMs: current.startedAtMs, lastSeenMs: now }
      : { totalSeconds: delta, startedAtMs: now - delta * 1000, lastSeenMs: now };
    this.live.delete(key);
    this.live.set(key, total);
    this.evictLive(now);
    await this.save(user, bookId, statsSessionId(absSessionId), total.startedAtMs, now, total.totalSeconds, source);
  }

  async recordLocal(user: RequestUser, listens: LocalListen[], source: ReadingSessionSource): Promise<void> {
    const now = Date.now();
    for (const listen of listens) {
      if (!(listen.timeListeningSeconds > 0)) continue;
      const endedAtMs = Math.min(listen.updatedAtMs, now);
      const startedAtMs = Math.min(listen.startedAtMs ?? endedAtMs - listen.timeListeningSeconds * 1000, endedAtMs);
      await this.save(user, listen.bookId, statsSessionId(listen.sessionId), startedAtMs, endedAtMs, listen.timeListeningSeconds, source);
    }
  }

  private async save(
    user: RequestUser,
    bookId: number,
    sessionId: string,
    startedAtMs: number,
    endedAtMs: number,
    seconds: number,
    source: ReadingSessionSource,
  ): Promise<void> {
    try {
      const [file] = (await this.repo.findTimelineFiles([bookId])).sort(compareAudioTracks);
      if (!file) return;
      await this.readingSessions.save(
        file.id,
        {
          sessionId,
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationSeconds: Math.floor(seconds),
          sessionType: 'listen',
        },
        user,
        source,
      );
    } catch (error) {
      this.logger.warn(
        `[abs.listening_stats] [fail] userId=${user.id} bookId=${bookId} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - listening stats not recorded`,
      );
    }
  }

  private evictLive(now: number): void {
    for (const [key, total] of this.live) {
      if (this.live.size <= MAX_LIVE_SESSIONS && now - total.lastSeenMs < LIVE_SESSION_IDLE_MS) break;
      this.live.delete(key);
    }
  }
}
