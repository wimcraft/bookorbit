export interface AbsFolder {
  id: string;
  fullPath: string;
  libraryId: string;
  addedAt: number;
}

export interface AbsLibrarySettings {
  coverAspectRatio: number;
  disableWatcher: boolean;
  skipMatchingMediaWithAsin: boolean;
  skipMatchingMediaWithIsbn: boolean;
  autoScanCronExpression: string | null;
  audiobooksOnly: boolean;
  epubsAllowScriptedContent: boolean;
  hideSingleBookSeries: boolean;
  onlyShowLaterBooksInContinueSeries: boolean;
  metadataPrecedence: string[];
  markAsFinishedPercentComplete: number | null;
  markAsFinishedTimeRemaining: number;
}

export interface AbsLibraryStats {
  totalItems: number;
  totalSize: number;
  totalDuration: number;
  numAudioFiles: number;
}

export interface AbsLibrary {
  id: string;
  name: string;
  folders: AbsFolder[];
  displayOrder: number;
  icon: string;
  mediaType: 'book';
  provider: string;
  settings: AbsLibrarySettings;
  lastScan: number | null;
  lastScanVersion: string | null;
  createdAt: number;
  lastUpdate: number;
  stats?: AbsLibraryStats;
}

export interface AbsFileMetadata {
  filename: string;
  ext: string;
  path: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface AbsAudioFile {
  index: number;
  ino: string;
  metadata: AbsFileMetadata;
  addedAt: number;
  updatedAt: number;
  trackNumFromMeta: number | null;
  discNumFromMeta: number | null;
  trackNumFromFilename: number | null;
  discNumFromFilename: number | null;
  manuallyVerified: boolean;
  exclude: boolean;
  error: string | null;
  format: string;
  duration: number;
  bitRate: number | null;
  language: string | null;
  codec: string | null;
  timeBase: string | null;
  channels: number | null;
  channelLayout: string | null;
  chapters: AbsChapter[];
  embeddedCoverArt: string | null;
  metaTags: Record<string, never>;
  mimeType: string;
}

export interface AbsAudioTrack {
  index: number;
  ino: string;
  startOffset: number;
  duration: number;
  title: string;
  contentUrl: string;
  mimeType: string;
  codec: string | null;
  metadata: AbsFileMetadata;
}

export interface AbsChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

export interface AbsAuthorRef {
  id: string;
  name: string;
}

export interface AbsSeriesRef {
  id: string;
  name: string;
  sequence: string | null;
}

export interface AbsBookMetadataMinified {
  title: string;
  titleIgnorePrefix: string;
  subtitle: string | null;
  authorName: string;
  authorNameLF: string;
  narratorName: string;
  seriesName: string;
  genres: string[];
  publishedYear: string | null;
  publishedDate: string | null;
  publisher: string | null;
  description: string | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  explicit: boolean;
  abridged: boolean;
}

export interface AbsBookMetadataExpanded extends AbsBookMetadataMinified {
  authors: AbsAuthorRef[];
  narrators: string[];
  series: AbsSeriesRef[];
  descriptionPlain: string | null;
}

export interface AbsBookMinified {
  id: string;
  metadata: AbsBookMetadataMinified;
  coverPath: string | null;
  tags: string[];
  numTracks: number;
  numAudioFiles: number;
  numChapters: number;
  duration: number;
  size: number;
  ebookFormat?: string;
}

export interface AbsBookExpanded extends Omit<AbsBookMinified, 'metadata'> {
  libraryItemId: string;
  metadata: AbsBookMetadataExpanded;
  audioFiles: AbsAudioFile[];
  chapters: AbsChapter[];
  ebookFile: null;
  tracks: AbsAudioTrack[];
}

export interface AbsLibraryItemBase {
  id: string;
  ino: string;
  oldLibraryItemId: null;
  libraryId: string;
  folderId: string;
  path: string;
  relPath: string;
  isFile: boolean;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  addedAt: number;
  updatedAt: number;
  isMissing: boolean;
  isInvalid: boolean;
  mediaType: 'book';
  numFiles: number;
  size: number;
}

export interface AbsLibraryItemMinified extends AbsLibraryItemBase {
  media: AbsBookMinified;
}

export interface AbsLibraryFile {
  ino: string;
  metadata: AbsFileMetadata;
  isSupplementary: boolean;
  addedAt: number;
  updatedAt: number;
  fileType: 'audio';
}

export interface AbsLibraryItemExpanded extends AbsLibraryItemBase {
  media: AbsBookExpanded;
  lastScan: number | null;
  scanVersion: string | null;
  libraryFiles: AbsLibraryFile[];
  userMediaProgress?: AbsMediaProgress;
}

export interface AbsMediaProgress {
  id: string;
  userId: string;
  libraryItemId: string;
  episodeId: null;
  mediaItemId: string;
  mediaItemType: 'book';
  duration: number;
  progress: number;
  currentTime: number;
  isFinished: boolean;
  hideFromContinueListening: boolean;
  ebookLocation: null;
  ebookProgress: number;
  lastUpdate: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface AbsUserPermissions {
  download: boolean;
  update: boolean;
  delete: boolean;
  upload: boolean;
  createEreader: boolean;
  accessAllLibraries: boolean;
  accessAllTags: boolean;
  accessExplicitContent: boolean;
  selectedTagsNotAccessible: boolean;
}

export interface AbsUser {
  id: string;
  username: string;
  email: string | null;
  type: 'admin' | 'user';
  token: string;
  isOldToken: boolean;
  mediaProgress: AbsMediaProgress[];
  seriesHideFromContinueListening: string[];
  bookmarks: never[];
  isActive: boolean;
  isLocked: boolean;
  lastSeen: number | null;
  createdAt: number;
  permissions: AbsUserPermissions;
  librariesAccessible: string[];
  itemTagsSelected: string[];
  hasOpenIDLink: boolean;
  accessToken?: string;
  refreshToken?: string | null;
}

export interface AbsServerSettings {
  id: string;
  version: string;
  language: string;
  scannerFindCovers: boolean;
  sortingIgnorePrefix: boolean;
  sortingPrefixes: string[];
  chromecastEnabled: boolean;
  homeBookshelfView: number;
  bookshelfView: number;
  dateFormat: string;
  timeFormat: string;
  allowedOrigins: string[];
  authActiveAuthMethods: string[];
  buildNumber: number;
  timeZone: string;
}

export interface AbsLoginPayload {
  user: AbsUser;
  userDefaultLibraryId: string | null;
  serverSettings: AbsServerSettings;
  ereaderDevices: never[];
  Source: string;
}

export interface AbsDeviceInfo {
  deviceId: string;
  clientName: string;
  clientVersion: string;
  manufacturer: string;
  model: string;
  sdkVersion: number;
}

export interface AbsPlaybackSession {
  id: string;
  userId: string;
  libraryId: string;
  libraryItemId: string;
  bookId: string;
  episodeId: null;
  mediaType: 'book';
  mediaMetadata: AbsBookMetadataExpanded;
  chapters: AbsChapter[];
  displayTitle: string;
  displayAuthor: string;
  coverPath: string | null;
  duration: number;
  playMethod: 0;
  mediaPlayer: string;
  deviceInfo: AbsDeviceInfo;
  serverVersion: string;
  date: string;
  dayOfWeek: string;
  timeListening: number;
  startTime: number;
  currentTime: number;
  startedAt: number;
  updatedAt: number;
  audioTracks: AbsAudioTrack[];
  libraryItem: AbsLibraryItemExpanded;
}
