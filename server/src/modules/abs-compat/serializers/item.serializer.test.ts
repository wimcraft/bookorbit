import { AUDIOBOOK_MANIFEST_SCHEMA, AUDIOBOOK_MANIFEST_VERSION, type AudiobookManifest } from '@bookorbit/types';

import {
  relativeFolder,
  titleIgnorePrefix,
  toChapters,
  toLibraryItemExpanded,
  toLibraryItemMinified,
  type AbsAudioFileSource,
  type AbsBookInfo,
  type AbsItemStats,
} from './item.serializer';
import { toAbsPlaybackSession, toAbsDeviceInfo } from './session.serializer';

const UUIDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

const book: AbsBookInfo = {
  id: 1287,
  libraryId: 3,
  title: 'The Long Road',
  subtitle: 'Part One',
  authors: [
    { id: 5, name: 'Ada Writer' },
    { id: 6, name: 'Ben Scribe' },
  ],
  narrators: ['Nora Voice'],
  series: [{ id: 9, name: 'Road Saga', sequence: '2' }],
  genres: ['Fantasy'],
  tags: ['favorite'],
  publishedYear: 2019,
  publishedDate: '2019-05-01',
  publisher: 'Press',
  language: 'en',
  description: '<p>A <b>long</b> road.</p>',
  isbn: '9781234567890',
  asin: null,
  abridged: false,
  hasCover: true,
  addedAt: '2026-01-02T03:04:05.000Z',
  updatedAt: new Date('2026-02-03T04:05:06.000Z'),
};

function makeManifest(durationsMs: number[], formats: string[], chapters: Array<{ title: string; startMs: number }>): AudiobookManifest {
  const total = durationsMs.reduce((sum, value) => sum + value, 0);
  return {
    schema: AUDIOBOOK_MANIFEST_SCHEMA,
    schemaVersion: AUDIOBOOK_MANIFEST_VERSION,
    revision: 'r'.repeat(64),
    book: { id: 1287, title: 'The Long Road', authors: ['Ada Writer'], narrators: [], hasCover: true },
    assets: durationsMs.map((durationMs, sequence) => ({
      assetId: `aud_${UUIDS[sequence]}`,
      fileId: 100 + sequence,
      sequence,
      format: formats[sequence]!,
      durationMs,
      sizeBytes: 1_000 * (sequence + 1),
      etag: `etag${sequence}`,
    })),
    chapters: chapters.map((chapter, sequence) => ({
      id: `ch_${sequence}`,
      title: chapter.title,
      assetId: `aud_${UUIDS[0]}`,
      sequence,
      startMs: chapter.startMs,
      endMs: chapters[sequence + 1]?.startMs ?? total,
      assetOffsetMs: 0,
    })),
    totalDurationMs: total,
  };
}

function makeSources(names: string[], formats: string[]): AbsAudioFileSource[] {
  return names.map((name, index) => ({
    fileId: 100 + index,
    publicId: UUIDS[index]!,
    absolutePath: `/srv/audiobooks/Ada Writer/The Long Road/${name}.${formats[index]}`,
    relPath: `Ada Writer/The Long Road/${name}.${formats[index]}`,
    sizeBytes: 1_000 * (index + 1),
    mtime: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
  }));
}

const stats: AbsItemStats = {
  folderPath: '/srv/audiobooks/Ada Writer/The Long Road',
  folderRoot: '/srv/audiobooks',
  fileCount: 3,
  sizeBytes: 6_000,
  durationSeconds: 2700,
  chapterCount: 3,
};

describe('item serializers', () => {
  describe('minified item', () => {
    const item = toLibraryItemMinified(book, stats);

    it('carries the fields the apps list and sort by', () => {
      expect(item).toEqual(
        expect.objectContaining({
          id: 'li-1287',
          libraryId: 'lib-3',
          folderId: 'fol-3',
          mediaType: 'book',
          isMissing: false,
          isInvalid: false,
          isFile: false,
          numFiles: 3,
          size: 6_000,
          addedAt: Date.parse('2026-01-02T03:04:05.000Z'),
          updatedAt: Date.parse('2026-02-03T04:05:06.000Z'),
        }),
      );
      expect(item.media).toEqual(
        expect.objectContaining({
          id: 'book-1287',
          numTracks: 3,
          numAudioFiles: 3,
          numChapters: 3,
          duration: 2700,
          size: 6_000,
          tags: ['favorite'],
        }),
      );
      expect(item.media.coverPath).toBeTruthy();
      expect(item.media.metadata).toEqual(
        expect.objectContaining({
          title: 'The Long Road',
          titleIgnorePrefix: 'Long Road, The',
          subtitle: 'Part One',
          authorName: 'Ada Writer, Ben Scribe',
          narratorName: 'Nora Voice',
          seriesName: 'Road Saga #2',
          publishedYear: '2019',
          explicit: false,
          abridged: false,
        }),
      );
    });

    it('never exposes an absolute filesystem path', () => {
      expect(item.path).toBe('Ada Writer/The Long Road');
      expect(item.relPath).toBe('Ada Writer/The Long Road');
      expect(JSON.stringify(item)).not.toContain('/srv/audiobooks');
    });

    it('reports no cover for a book without one', () => {
      expect(toLibraryItemMinified({ ...book, hasCover: false }, stats).media.coverPath).toBeNull();
    });
  });

  describe('expanded item from three MP3 tracks with a chapter across a file boundary', () => {
    const formats = ['mp3', 'mp3', 'mp3'];
    const manifest = makeManifest([600_000, 900_000, 1_200_000], formats, [
      { title: 'Prologue', startMs: 0 },
      { title: 'Crossing', startMs: 500_000 },
      { title: 'Arrival', startMs: 1_800_000 },
    ]);
    const item = toLibraryItemExpanded(book, stats, manifest, makeSources(['01', '02', '03'], formats));

    it('lists audio files in playback order with the file public id as ino', () => {
      expect(item.media.audioFiles.map((file) => [file.index, file.ino, file.duration, file.mimeType, file.metadata.ext])).toEqual([
        [1, UUIDS[0], 600, 'audio/mpeg', '.mp3'],
        [2, UUIDS[1], 900, 'audio/mpeg', '.mp3'],
        [3, UUIDS[2], 1200, 'audio/mpeg', '.mp3'],
      ]);
      expect(item.media.audioFiles[1]!.metadata).toEqual(
        expect.objectContaining({
          filename: '02.mp3',
          relPath: 'Ada Writer/The Long Road/02.mp3',
          path: 'Ada Writer/The Long Road/02.mp3',
          size: 2_000,
        }),
      );
    });

    it('builds tracks with cumulative start offsets and a relative content url', () => {
      expect(item.media.tracks.map((track) => [track.index, track.startOffset, track.duration, track.contentUrl])).toEqual([
        [1, 0, 600, `/api/items/li-1287/file/${UUIDS[0]}`],
        [2, 600, 900, `/api/items/li-1287/file/${UUIDS[1]}`],
        [3, 1500, 1200, `/api/items/li-1287/file/${UUIDS[2]}`],
      ]);
      expect(item.media.tracks[0]).toEqual(
        expect.objectContaining({ title: '01.mp3', mimeType: 'audio/mpeg', metadata: expect.objectContaining({ filename: '01.mp3' }) }),
      );
    });

    it('keeps absolute chapter ranges, including the one spanning files', () => {
      expect(item.media.chapters).toEqual([
        { id: 0, start: 0, end: 500, title: 'Prologue' },
        { id: 1, start: 500, end: 1800, title: 'Crossing' },
        { id: 2, start: 1800, end: 2700, title: 'Arrival' },
      ]);
      expect(toChapters(manifest)).toEqual(item.media.chapters);
    });

    it('sets totals from the manifest and mirrors the minified fields', () => {
      const minified = toLibraryItemMinified(book, stats);
      expect(item.media.duration).toBe(2700);
      expect(item.media.numTracks).toBe(3);
      expect(item.media.numChapters).toBe(3);
      expect(item.media.libraryItemId).toBe('li-1287');
      expect(item.media.ebookFile).toBeNull();
      expect(item.libraryFiles.map((file) => file.ino)).toEqual(UUIDS);
      for (const key of Object.keys(minified)) expect(item).toHaveProperty(key);
      for (const key of Object.keys(minified.media)) expect(item.media).toHaveProperty(key);
    });

    it('expands metadata with ids, series and plain text description', () => {
      expect(item.media.metadata).toEqual(
        expect.objectContaining({
          authors: [
            { id: 'aut-5', name: 'Ada Writer' },
            { id: 'aut-6', name: 'Ben Scribe' },
          ],
          narrators: ['Nora Voice'],
          series: [{ id: 'ser-9', name: 'Road Saga', sequence: '2' }],
          descriptionPlain: 'A long road.',
        }),
      );
    });

    it('attaches progress only when given', () => {
      expect(item).not.toHaveProperty('userMediaProgress');
      const progress = {
        id: 'mp-1287',
        userId: 'usr-1',
        libraryItemId: 'li-1287',
        episodeId: null,
        mediaItemId: 'book-1287',
        mediaItemType: 'book' as const,
        duration: 2700,
        progress: 0.5,
        currentTime: 1350,
        isFinished: false,
        hideFromContinueListening: false,
        ebookLocation: null,
        ebookProgress: 0,
        lastUpdate: 1,
        startedAt: 1,
        finishedAt: null,
      };
      expect(toLibraryItemExpanded(book, stats, manifest, makeSources(['01', '02', '03'], formats), progress).userMediaProgress).toEqual(progress);
    });
  });

  describe('expanded item from a single M4B', () => {
    const manifest = makeManifest(
      [36_000_000],
      ['m4b'],
      [
        { title: 'Chapter 1', startMs: 0 },
        { title: 'Chapter 2', startMs: 18_000_000 },
      ],
    );
    const item = toLibraryItemExpanded(
      book,
      { ...stats, fileCount: 1, durationSeconds: 36_000, chapterCount: 2 },
      manifest,
      makeSources(['book'], ['m4b']),
    );

    it('exposes one track covering the whole book', () => {
      expect(item.media.tracks).toHaveLength(1);
      expect(item.media.tracks[0]).toEqual(expect.objectContaining({ index: 1, startOffset: 0, duration: 36_000, mimeType: 'audio/mp4' }));
      expect(item.media.audioFiles[0]!.format).toBe('M4B');
      expect(item.media.duration).toBe(36_000);
      expect(item.media.chapters.map((chapter) => chapter.end)).toEqual([18_000, 36_000]);
    });
  });

  describe('playback session', () => {
    const formats = ['mp3', 'mp3', 'mp3'];
    const manifest = makeManifest([600_000, 900_000, 1_200_000], formats, [{ title: 'Prologue', startMs: 0 }]);
    const item = toLibraryItemExpanded(book, stats, manifest, makeSources(['01', '02', '03'], formats));
    const now = new Date('2026-04-05T06:07:08.000Z');

    it('is a direct play session carrying everything the player needs', () => {
      const session = toAbsPlaybackSession({
        sessionId: 'ps-1287-test',
        userId: 4,
        item,
        bookId: 1287,
        currentTimeSeconds: 700,
        deviceInfo: toAbsDeviceInfo({ deviceId: 'abc', manufacturer: 'Google', model: 'Pixel', sdkVersion: 34, clientVersion: '0.14.0' }, 'x'),
        mediaPlayer: 'exo-player',
        now,
      });

      expect(session).toEqual(
        expect.objectContaining({
          id: 'ps-1287-test',
          userId: 'usr-4',
          libraryId: 'lib-3',
          libraryItemId: 'li-1287',
          bookId: 'book-1287',
          episodeId: null,
          mediaType: 'book',
          displayTitle: 'The Long Road',
          displayAuthor: 'Ada Writer, Ben Scribe',
          duration: 2700,
          playMethod: 0,
          currentTime: 700,
          startTime: 700,
          timeListening: 0,
          startedAt: now.getTime(),
          updatedAt: now.getTime(),
          date: '2026-04-05',
          dayOfWeek: 'Sunday',
          mediaPlayer: 'exo-player',
        }),
      );
      expect(session.audioTracks).toBe(item.media.tracks);
      expect(session.libraryItem.id).toBe('li-1287');
      expect(session.deviceInfo).toEqual({
        deviceId: 'abc',
        clientName: 'x',
        clientVersion: '0.14.0',
        manufacturer: 'Google',
        model: 'Pixel',
        sdkVersion: 34,
      });
    });

    it('fills device info with non null defaults the app requires', () => {
      expect(toAbsDeviceInfo(undefined, 'Audiobookshelf client')).toEqual({
        deviceId: 'unknown',
        clientName: 'Audiobookshelf client',
        clientVersion: '',
        manufacturer: '',
        model: '',
        sdkVersion: 0,
      });
    });
  });

  describe('helpers', () => {
    it('moves a leading article to the end for sorting', () => {
      expect(titleIgnorePrefix('The Hobbit')).toBe('Hobbit, The');
      expect(titleIgnorePrefix('A Wizard of Earthsea')).toBe('Wizard of Earthsea, A');
      expect(titleIgnorePrefix('Anathem')).toBe('Anathem');
      expect(titleIgnorePrefix('The')).toBe('The');
    });

    it('derives a folder relative to its library root and never escapes it', () => {
      expect(relativeFolder('/srv/audiobooks', '/srv/audiobooks/A/B')).toBe('A/B');
      expect(relativeFolder('/srv/audiobooks', '/elsewhere/Book')).toBe('Book');
    });
  });
});
