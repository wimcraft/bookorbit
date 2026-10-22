import { ABS_COMPAT_LANGUAGE, ABS_COMPAT_SERVER_VERSION, ABS_COMPAT_SOURCE } from '../abs-compat.constants';
import { encodeLibraryId, encodeUserId } from '../abs-ids';
import type { AbsAudioBookmark, AbsLoginPayload, AbsMediaProgress, AbsServerSettings, AbsUser } from '../abs-compat.types';

export interface UserSource {
  id: number;
  username: string;
  email: string | null;
  isSuperuser: boolean;
  active: boolean;
}

export function toAbsServerSettings(): AbsServerSettings {
  return {
    id: 'server-settings',
    version: ABS_COMPAT_SERVER_VERSION,
    language: ABS_COMPAT_LANGUAGE,
    scannerFindCovers: false,
    sortingIgnorePrefix: false,
    sortingPrefixes: ['the', 'a'],
    chromecastEnabled: false,
    homeBookshelfView: 1,
    bookshelfView: 1,
    dateFormat: 'MM/dd/yyyy',
    timeFormat: 'HH:mm',
    allowedOrigins: [],
    authActiveAuthMethods: ['local'],
    buildNumber: 1,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

export function toAbsUser(
  source: UserSource,
  mediaProgress: AbsMediaProgress[],
  libraryIds: number[],
  token = '',
  now: number = Date.now(),
  bookmarks: AbsAudioBookmark[] = [],
): AbsUser {
  return {
    id: encodeUserId(source.id),
    username: source.username,
    email: source.email,
    type: source.isSuperuser ? 'admin' : 'user',
    token,
    isOldToken: false,
    mediaProgress,
    seriesHideFromContinueListening: [],
    bookmarks,
    isActive: source.active,
    isLocked: false,
    lastSeen: now,
    createdAt: 0,
    permissions: {
      download: true,
      update: false,
      delete: false,
      upload: false,
      createEreader: false,
      accessAllLibraries: true,
      accessAllTags: true,
      accessExplicitContent: true,
      selectedTagsNotAccessible: false,
    },
    librariesAccessible: libraryIds.map(encodeLibraryId),
    itemTagsSelected: [],
    hasOpenIDLink: false,
  };
}

export function toAbsLoginPayload(user: AbsUser, defaultLibraryId: number | null): AbsLoginPayload {
  return {
    user,
    userDefaultLibraryId: defaultLibraryId === null ? null : encodeLibraryId(defaultLibraryId),
    serverSettings: toAbsServerSettings(),
    ereaderDevices: [],
    Source: ABS_COMPAT_SOURCE,
  };
}
