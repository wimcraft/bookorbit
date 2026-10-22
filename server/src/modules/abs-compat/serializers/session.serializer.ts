import { encodeItemId, encodeMediaId, encodeUserId } from '../abs-ids';
import { ABS_COMPAT_SERVER_VERSION } from '../abs-compat.constants';
import type { AbsDeviceInfo, AbsLibraryItemExpanded, AbsPlaybackSession } from '../abs-compat.types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : fallback;
}

export function toAbsDeviceInfo(raw: unknown, fallbackClientName: string): AbsDeviceInfo {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sdkVersion = typeof source.sdkVersion === 'number' && Number.isFinite(source.sdkVersion) ? Math.trunc(source.sdkVersion) : 0;
  return {
    deviceId: readString(source.deviceId, 'unknown'),
    clientName: readString(source.clientName, fallbackClientName),
    clientVersion: readString(source.clientVersion, ''),
    manufacturer: readString(source.manufacturer, ''),
    model: readString(source.model, ''),
    sdkVersion,
  };
}

export function toAbsPlaybackSession(input: {
  sessionId: string;
  userId: number;
  item: AbsLibraryItemExpanded;
  bookId: number;
  currentTimeSeconds: number;
  deviceInfo: AbsDeviceInfo;
  mediaPlayer: string;
  now?: Date;
}): AbsPlaybackSession {
  const now = input.now ?? new Date();
  const { media } = input.item;
  return {
    id: input.sessionId,
    userId: encodeUserId(input.userId),
    libraryId: input.item.libraryId,
    libraryItemId: encodeItemId(input.bookId),
    bookId: encodeMediaId(input.bookId),
    episodeId: null,
    mediaType: 'book',
    mediaMetadata: media.metadata,
    chapters: media.chapters,
    displayTitle: media.metadata.title,
    displayAuthor: media.metadata.authorName,
    coverPath: media.coverPath,
    duration: media.duration,
    playMethod: 0,
    mediaPlayer: input.mediaPlayer,
    deviceInfo: input.deviceInfo,
    serverVersion: ABS_COMPAT_SERVER_VERSION,
    date: now.toISOString().slice(0, 10),
    dayOfWeek: DAY_NAMES[now.getUTCDay()]!,
    timeListening: 0,
    startTime: input.currentTimeSeconds,
    currentTime: input.currentTimeSeconds,
    startedAt: now.getTime(),
    updatedAt: now.getTime(),
    audioTracks: media.tracks,
    libraryItem: input.item,
  };
}
