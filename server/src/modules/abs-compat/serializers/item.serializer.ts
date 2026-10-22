import { basename, extname, relative } from 'node:path';

import type { AudiobookManifest } from '@bookorbit/types';

import { audioMimeType } from '../../../common/utils/audio-stream.utils';
import { encodeAuthorId, encodeFolderId, encodeItemId, encodeLibraryId, encodeMediaId, encodeSeriesId } from '../abs-ids';
import type {
  AbsAudioFile,
  AbsAudioTrack,
  AbsBookMetadataExpanded,
  AbsBookMetadataMinified,
  AbsChapter,
  AbsLibraryFile,
  AbsLibraryItemExpanded,
  AbsLibraryItemMinified,
  AbsMediaProgress,
} from '../abs-compat.types';

export interface AbsBookInfo {
  id: number;
  libraryId: number;
  title: string;
  subtitle: string | null;
  authors: Array<{ id: number | null; name: string }>;
  narrators: string[];
  series: Array<{ id: number | null; name: string; sequence: string | null }>;
  genres: string[];
  tags: string[];
  publishedYear: number | null;
  publishedDate: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  isbn: string | null;
  asin: string | null;
  abridged: boolean;
  hasCover: boolean;
  addedAt: Date | string;
  updatedAt: Date | string | null;
}

export interface AbsItemStats {
  folderPath: string;
  folderRoot: string;
  fileCount: number;
  sizeBytes: number;
  durationSeconds: number;
  chapterCount: number;
}

export interface AbsAudioFileSource {
  fileId: number;
  publicId: string;
  absolutePath: string;
  relPath: string | null;
  sizeBytes: number | null;
  mtime: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const TITLE_PREFIXES = ['the', 'a', 'an'];

function toMs(value: Date | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : fallback;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function titleIgnorePrefix(title: string): string {
  const [first, ...rest] = title.split(' ');
  if (first && rest.length > 0 && TITLE_PREFIXES.includes(first.toLowerCase())) return `${rest.join(' ')}, ${first}`;
  return title;
}

function stripTags(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesDisplayName(series: AbsBookInfo['series']): string {
  const first = series[0];
  if (!first) return '';
  return first.sequence ? `${first.name} #${first.sequence}` : first.name;
}

export function relativeFolder(folderRoot: string, folderPath: string): string {
  const rel = relative(folderRoot, folderPath);
  if (!rel || rel.startsWith('..')) return basename(folderPath);
  return rel.split('\\').join('/');
}

export function toMetadataMinified(book: AbsBookInfo): AbsBookMetadataMinified {
  const authorName = book.authors.map((author) => author.name).join(', ');
  return {
    title: book.title,
    titleIgnorePrefix: titleIgnorePrefix(book.title),
    subtitle: book.subtitle,
    authorName,
    authorNameLF: authorName,
    narratorName: book.narrators.join(', '),
    seriesName: seriesDisplayName(book.series),
    genres: [...book.genres],
    publishedYear: book.publishedYear === null ? null : String(book.publishedYear),
    publishedDate: book.publishedDate,
    publisher: book.publisher,
    description: book.description,
    isbn: book.isbn,
    asin: book.asin,
    language: book.language,
    explicit: false,
    abridged: book.abridged,
  };
}

export function toMetadataExpanded(book: AbsBookInfo): AbsBookMetadataExpanded {
  return {
    ...toMetadataMinified(book),
    authors: book.authors.map((author) => ({ id: author.id === null ? `aut-name-${author.name}` : encodeAuthorId(author.id), name: author.name })),
    narrators: [...book.narrators],
    series: book.series.map((series) => ({
      id: series.id === null ? `ser-name-${series.name}` : encodeSeriesId(series.id),
      name: series.name,
      sequence: series.sequence,
    })),
    descriptionPlain: stripTags(book.description),
  };
}

function itemBase(book: AbsBookInfo, stats: AbsItemStats) {
  const rel = relativeFolder(stats.folderRoot, stats.folderPath);
  const addedAt = toMs(book.addedAt);
  const updatedAt = toMs(book.updatedAt, addedAt);
  return {
    id: encodeItemId(book.id),
    ino: '',
    oldLibraryItemId: null,
    libraryId: encodeLibraryId(book.libraryId),
    folderId: encodeFolderId(book.libraryId),
    path: rel,
    relPath: rel,
    isFile: false,
    mtimeMs: updatedAt,
    ctimeMs: updatedAt,
    birthtimeMs: addedAt,
    addedAt,
    updatedAt,
    isMissing: false,
    isInvalid: false,
    mediaType: 'book' as const,
    numFiles: stats.fileCount,
    size: stats.sizeBytes,
  };
}

export function toLibraryItemMinified(book: AbsBookInfo, stats: AbsItemStats): AbsLibraryItemMinified {
  return {
    ...itemBase(book, stats),
    media: {
      id: encodeMediaId(book.id),
      metadata: toMetadataMinified(book),
      coverPath: book.hasCover ? `/covers/${encodeItemId(book.id)}` : null,
      tags: [...book.tags],
      numTracks: stats.fileCount,
      numAudioFiles: stats.fileCount,
      numChapters: stats.chapterCount,
      duration: stats.durationSeconds,
      size: stats.sizeBytes,
    },
  };
}

function fileMetadata(source: AbsAudioFileSource) {
  const filename = basename(source.absolutePath);
  const rel = source.relPath ? source.relPath.split('\\').join('/') : filename;
  const mtimeMs = toMs(source.mtime, toMs(source.updatedAt));
  return {
    filename,
    ext: extname(filename),
    path: rel,
    relPath: rel,
    size: source.sizeBytes ?? 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    birthtimeMs: toMs(source.createdAt),
  };
}

export function toAudioFiles(manifest: AudiobookManifest, sources: AbsAudioFileSource[]): AbsAudioFile[] {
  const byFileId = new Map(sources.map((source) => [source.fileId, source]));
  return manifest.assets.flatMap<AbsAudioFile>((asset) => {
    const source = byFileId.get(asset.fileId);
    if (!source) return [];
    return [
      {
        index: asset.sequence + 1,
        ino: source.publicId,
        metadata: fileMetadata(source),
        addedAt: toMs(source.createdAt),
        updatedAt: toMs(source.updatedAt),
        trackNumFromMeta: null,
        discNumFromMeta: null,
        trackNumFromFilename: null,
        discNumFromFilename: null,
        manuallyVerified: false,
        exclude: false,
        error: null,
        format: asset.format.toUpperCase(),
        duration: round3((asset.durationMs ?? 0) / 1000),
        bitRate: null,
        language: null,
        codec: null,
        timeBase: null,
        channels: null,
        channelLayout: null,
        chapters: [],
        embeddedCoverArt: null,
        metaTags: {},
        mimeType: audioMimeType(asset.format),
      },
    ];
  });
}

export function toTracks(bookId: number, audioFiles: AbsAudioFile[]): AbsAudioTrack[] {
  let startOffset = 0;
  return audioFiles.map((file) => {
    const track: AbsAudioTrack = {
      index: file.index,
      ino: file.ino,
      startOffset: round3(startOffset),
      duration: file.duration,
      title: file.metadata.filename,
      contentUrl: `/api/items/${encodeItemId(bookId)}/file/${file.ino}`,
      mimeType: file.mimeType,
      codec: file.codec,
      metadata: file.metadata,
    };
    startOffset += file.duration;
    return track;
  });
}

export function toChapters(manifest: AudiobookManifest): AbsChapter[] {
  return manifest.chapters.map((chapter, index) => ({
    id: index,
    start: round3(chapter.startMs / 1000),
    end: round3(chapter.endMs / 1000),
    title: chapter.title,
  }));
}

export function toLibraryItemExpanded(
  book: AbsBookInfo,
  stats: AbsItemStats,
  manifest: AudiobookManifest,
  sources: AbsAudioFileSource[],
  userMediaProgress?: AbsMediaProgress | null,
): AbsLibraryItemExpanded {
  const base = itemBase(book, stats);
  const audioFiles = toAudioFiles(manifest, sources);
  const libraryFiles = audioFiles.map<AbsLibraryFile>((file) => ({
    ino: file.ino,
    metadata: file.metadata,
    isSupplementary: false,
    addedAt: file.addedAt,
    updatedAt: file.updatedAt,
    fileType: 'audio',
  }));
  const minified = toLibraryItemMinified(book, stats);
  const duration = round3(manifest.totalDurationMs / 1000);
  return {
    ...base,
    lastScan: null,
    scanVersion: null,
    media: {
      ...minified.media,
      libraryItemId: base.id,
      metadata: toMetadataExpanded(book),
      numTracks: audioFiles.length,
      numAudioFiles: audioFiles.length,
      numChapters: manifest.chapters.length,
      duration,
      audioFiles,
      chapters: toChapters(manifest),
      ebookFile: null,
      tracks: toTracks(book.id, audioFiles),
    },
    libraryFiles,
    ...(userMediaProgress ? { userMediaProgress } : {}),
  };
}
