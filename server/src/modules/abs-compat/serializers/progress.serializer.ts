import { encodeItemId, encodeMediaId, encodeProgressId, encodeUserId } from '../abs-ids';
import type { AbsMediaProgress } from '../abs-compat.types';

export interface ProgressSource {
  userId: number;
  bookId: number;
  durationSeconds: number;
  currentTimeSeconds: number;
  percentage: number;
  capturedAt: Date;
  readStatus: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

// Statuses a user sets to say "not listened yet". BookOrbit keeps the position when they are set by hand.
const NOT_STARTED_STATUSES = new Set(['unread', 'want_to_read']);

export function isProgressFinished(percentage: number, readStatus: string | null): boolean {
  if (readStatus !== null && NOT_STARTED_STATUSES.has(readStatus)) return false;
  return percentage >= 100 || readStatus === 'read';
}

export function toAbsMediaProgress(source: ProgressSource): AbsMediaProgress {
  const isFinished = isProgressFinished(source.percentage, source.readStatus);
  // A book moved back to unread after it was finished would otherwise resume at its last second; ABS
  // plays it from the start, as the play endpoint already does for a completed position.
  const restart = !isFinished && source.percentage >= 100;
  const lastUpdate = source.capturedAt.getTime();
  return {
    id: encodeProgressId(source.bookId),
    userId: encodeUserId(source.userId),
    libraryItemId: encodeItemId(source.bookId),
    episodeId: null,
    mediaItemId: encodeMediaId(source.bookId),
    mediaItemType: 'book',
    duration: source.durationSeconds,
    progress: isFinished ? 1 : restart ? 0 : Math.max(0, Math.min(1, source.percentage / 100)),
    currentTime: restart ? 0 : source.currentTimeSeconds,
    isFinished,
    hideFromContinueListening: false,
    ebookLocation: null,
    ebookProgress: 0,
    lastUpdate,
    startedAt: source.startedAt?.getTime() ?? lastUpdate,
    finishedAt: isFinished ? (source.finishedAt?.getTime() ?? lastUpdate) : null,
  };
}
