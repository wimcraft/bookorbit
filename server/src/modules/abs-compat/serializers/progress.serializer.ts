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

export function isProgressFinished(percentage: number, readStatus: string | null): boolean {
  return percentage >= 100 || readStatus === 'read';
}

export function toAbsMediaProgress(source: ProgressSource): AbsMediaProgress {
  const isFinished = isProgressFinished(source.percentage, source.readStatus);
  const lastUpdate = source.capturedAt.getTime();
  return {
    id: encodeProgressId(source.bookId),
    userId: encodeUserId(source.userId),
    libraryItemId: encodeItemId(source.bookId),
    episodeId: null,
    mediaItemId: encodeMediaId(source.bookId),
    mediaItemType: 'book',
    duration: source.durationSeconds,
    progress: isFinished ? 1 : Math.max(0, Math.min(1, source.percentage / 100)),
    currentTime: source.currentTimeSeconds,
    isFinished,
    hideFromContinueListening: false,
    ebookLocation: null,
    ebookProgress: 0,
    lastUpdate,
    startedAt: source.startedAt?.getTime() ?? lastUpdate,
    finishedAt: isFinished ? (source.finishedAt?.getTime() ?? lastUpdate) : null,
  };
}
