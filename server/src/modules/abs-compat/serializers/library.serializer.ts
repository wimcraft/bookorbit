import { ABS_LIBRARY_ICON } from '../abs-compat.constants';
import { encodeFolderId, encodeLibraryId } from '../abs-ids';
import type { AbsLibrary, AbsLibraryStats } from '../abs-compat.types';

export interface LibrarySource {
  id: number;
  name: string;
  displayOrder: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function toMs(value: Date | string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** The apps only need a folder entry to exist; the real path stays on the server. */
export function toAbsLibrary(source: LibrarySource, stats?: AbsLibraryStats): AbsLibrary {
  const libraryId = encodeLibraryId(source.id);
  const createdAt = toMs(source.createdAt);
  return {
    id: libraryId,
    name: source.name,
    folders: [{ id: encodeFolderId(source.id), fullPath: '/', libraryId, addedAt: createdAt }],
    displayOrder: source.displayOrder,
    icon: ABS_LIBRARY_ICON,
    mediaType: 'book',
    provider: 'google',
    settings: {
      coverAspectRatio: 1,
      disableWatcher: true,
      skipMatchingMediaWithAsin: false,
      skipMatchingMediaWithIsbn: false,
      autoScanCronExpression: null,
      audiobooksOnly: true,
      epubsAllowScriptedContent: false,
      hideSingleBookSeries: false,
      onlyShowLaterBooksInContinueSeries: false,
      metadataPrecedence: ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'],
      markAsFinishedPercentComplete: null,
      markAsFinishedTimeRemaining: 10,
    },
    lastScan: null,
    lastScanVersion: null,
    createdAt,
    lastUpdate: toMs(source.updatedAt),
    ...(stats ? { stats } : {}),
  };
}

export function emptyFilterData() {
  return {
    authors: [],
    genres: [],
    tags: [],
    series: [],
    narrators: [],
    languages: [],
    publishers: [],
    publishedDecades: [],
    bookCount: 0,
    authorCount: 0,
    seriesCount: 0,
    podcastCount: 0,
    numIssues: 0,
    loadedAt: Date.now(),
  };
}
