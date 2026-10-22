import { NotFoundException } from '@nestjs/common';
import {
  AUDIOBOOK_MANIFEST_SCHEMA,
  AUDIOBOOK_MANIFEST_VERSION,
  type AudiobookManifest,
  type AudiobookPlaybackState,
  type BookCard,
} from '@bookorbit/types';

import { verifyPlaybackSessionId } from '../abs-ids';
import { makeUser } from '../abs-test-support';
import { AbsItemService, itemDurationSeconds, startTimeSeconds } from './abs-item.service';

const SECRET = 'item-secret';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const manifest: AudiobookManifest = {
  schema: AUDIOBOOK_MANIFEST_SCHEMA,
  schemaVersion: AUDIOBOOK_MANIFEST_VERSION,
  revision: 'r'.repeat(64),
  book: { id: 30, title: 'Two Parts', authors: [], narrators: [], hasCover: false },
  assets: [
    { assetId: `aud_${A}`, fileId: 11, sequence: 0, format: 'mp3', durationMs: 600_000, sizeBytes: 1_000, etag: 'e1' },
    { assetId: `aud_${B}`, fileId: 12, sequence: 1, format: 'mp3', durationMs: 900_000, sizeBytes: 2_000, etag: 'e2' },
  ],
  chapters: [],
  totalDurationMs: 1_500_000,
};

const state = (overrides: Partial<AudiobookPlaybackState> = {}): AudiobookPlaybackState => ({
  assetId: `aud_${B}`,
  positionMs: 30_000,
  percentage: 42,
  completed: false,
  capturedAt: '2026-03-10T18:00:00.000Z',
  revision: 2,
  manifestRevision: manifest.revision,
  ...overrides,
});

const facts = (overrides: Record<string, unknown> = {}) => ({
  bookId: 30,
  libraryId: 4,
  folderPath: '/lib/Author/Two Parts',
  folderRoot: '/lib',
  metaDurationSeconds: 1_499,
  chapterCount: 0,
  fileCount: 2,
  sizeBytes: 3_000,
  durationSeconds: 1_500,
  missingDurations: 0,
  ...overrides,
});

const card = (id: number, overrides: Partial<BookCard> = {}): BookCard =>
  ({
    id,
    title: `Book ${id}`,
    authors: ['Author'],
    narrators: ['Narrator'],
    seriesName: null,
    seriesIndex: null,
    files: [],
    genres: [],
    tags: [],
    hasCover: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    subtitle: null,
    publisher: null,
    isbn13: null,
    publishedYear: null,
    publishedDate: null,
    language: null,
    ...overrides,
  }) as unknown as BookCard;

function setup() {
  const repo = {
    findItemFacts: vi.fn().mockResolvedValue(new Map([[30, facts()]])),
    findAudioFileDetails: vi.fn().mockResolvedValue([
      {
        id: 11,
        publicId: A,
        absolutePath: '/lib/Author/Two Parts/01.mp3',
        relPath: 'Author/Two Parts/01.mp3',
        sizeBytes: 1_000,
        mtime: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: 12,
        publicId: B,
        absolutePath: '/lib/Author/Two Parts/02.mp3',
        relPath: 'Author/Two Parts/02.mp3',
        sizeBytes: 2_000,
        mtime: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]),
  };
  const audiobookService = {
    getManifest: vi.fn().mockResolvedValue(manifest),
    getPlaybackState: vi.fn().mockResolvedValue(state()),
  };
  const bookService = {
    getDetail: vi.fn().mockResolvedValue({
      id: 30,
      libraryId: 4,
      title: 'Two Parts',
      subtitle: null,
      description: null,
      isbn10: null,
      isbn13: null,
      publisher: null,
      publishedDate: null,
      publishedYear: null,
      language: null,
      seriesId: null,
      seriesName: null,
      seriesIndex: null,
      seriesMemberships: [],
      folderPath: '/lib/Author/Two Parts',
      authors: [{ id: 5, name: 'Author' }],
      genres: [],
      tags: [],
      providerIds: {},
      audioMetadata: { narrators: [], durationSeconds: 1_500, chapters: null, abridged: false },
      coverSource: 'extracted',
      addedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: null,
    }),
  };
  const progressService = { findForBook: vi.fn().mockResolvedValue({ id: 'mp-30', currentTime: 630 }) };
  const service = new AbsItemService(
    repo as never,
    audiobookService as never,
    bookService as never,
    progressService as never,
    { jwtSecret: SECRET } as never,
  );
  return { service, repo, audiobookService, bookService, progressService };
}

describe('item helpers', () => {
  it('sums file durations when all are known and falls back to book metadata otherwise', () => {
    expect(itemDurationSeconds(facts())).toBe(1_500);
    expect(itemDurationSeconds(facts({ missingDurations: 1 }))).toBe(1_499);
    expect(itemDurationSeconds(facts({ missingDurations: 1, metaDurationSeconds: null }))).toBe(1_500);
    expect(itemDurationSeconds(facts({ fileCount: 0, durationSeconds: 0, metaDurationSeconds: 77 }))).toBe(77);
  });

  it('starts at the stored absolute position, and over when the book was finished', () => {
    expect(startTimeSeconds(manifest, state())).toBe(630);
    expect(startTimeSeconds(manifest, state({ assetId: `aud_${A}`, positionMs: 5_500 }))).toBe(5.5);
    expect(startTimeSeconds(manifest, state({ completed: true }))).toBe(0);
    expect(startTimeSeconds(manifest, state({ assetId: 'aud_gone' }))).toBe(0);
    expect(startTimeSeconds(manifest, null)).toBe(0);
  });
});

describe('AbsItemService', () => {
  describe('minifyCards', () => {
    it('reads the facts of a whole page in one query and takes the library from them', async () => {
      const { service, repo } = setup();
      repo.findItemFacts.mockResolvedValue(
        new Map([
          [30, facts()],
          [
            31,
            facts({
              bookId: 31,
              libraryId: 9,
              folderPath: '/other/B',
              folderRoot: '/other',
              fileCount: 1,
              sizeBytes: 10,
              durationSeconds: 60,
              metaDurationSeconds: null,
            }),
          ],
        ]),
      );

      const items = await service.minifyCards([card(30), card(31)]);

      expect(repo.findItemFacts).toHaveBeenCalledTimes(1);
      expect(repo.findItemFacts).toHaveBeenCalledWith([30, 31]);
      expect(items.map((item) => [item.id, item.libraryId, item.media.duration, item.media.numTracks])).toEqual([
        ['li-30', 'lib-4', 1_500, 2],
        ['li-31', 'lib-9', 60, 1],
      ]);
    });

    it('leaves out a card that has no audio files', async () => {
      const { service, repo } = setup();
      repo.findItemFacts.mockResolvedValue(
        new Map([
          [30, facts()],
          [31, facts({ bookId: 31, fileCount: 0 })],
        ]),
      );

      const items = await service.minifyCards([card(30), card(31), card(32)]);

      expect(items.map((item) => item.id)).toEqual(['li-30']);
    });

    it('makes no query for an empty page', async () => {
      const { service, repo } = setup();

      await expect(service.minifyCards([])).resolves.toEqual([]);
      expect(repo.findItemFacts).toHaveBeenCalledWith([]);
    });
  });

  describe('getExpanded', () => {
    it('builds the item through the access checked manifest', async () => {
      const { service, audiobookService } = setup();
      const user = makeUser();

      const item = await service.getExpanded(user, 'li-30');

      expect(audiobookService.getManifest).toHaveBeenCalledWith(30, user);
      expect(item.media.tracks.map((track) => track.contentUrl)).toEqual([`/api/items/li-30/file/${A}`, `/api/items/li-30/file/${B}`]);
      expect(item.media.duration).toBe(1_500);
      expect(item.relPath).toBe('Author/Two Parts');
    });

    it('attaches the user progress only when asked for it', async () => {
      const { service, progressService } = setup();
      const user = makeUser();

      const without = await service.getExpanded(user, 'li-30');
      expect(without).not.toHaveProperty('userMediaProgress');
      expect(progressService.findForBook).not.toHaveBeenCalled();

      const withProgress = await service.getExpanded(user, 'li-30', true);
      expect(withProgress.userMediaProgress).toEqual({ id: 'mp-30', currentTime: 630 });
      expect(progressService.findForBook).toHaveBeenCalledWith(user, 30);
    });

    it('propagates a refused book and rejects a malformed id', async () => {
      const { service, audiobookService } = setup();
      audiobookService.getManifest.mockRejectedValue(new NotFoundException('Book 30 not found'));

      await expect(service.getExpanded(makeUser(), 'li-30')).rejects.toThrow(NotFoundException);
      await expect(service.getExpanded(makeUser(), 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('play', () => {
    it('opens a direct play session at the stored position with a signed id', async () => {
      const { service } = setup();
      const user = makeUser(7, { sessionId: 12, authenticationMethod: 'password' });

      const session = await service.play(user, 'li-30', {
        mediaPlayer: 'exo-player',
        forceDirectPlay: true,
        deviceInfo: { deviceId: 'abc', model: 'Pixel', manufacturer: 'Google', sdkVersion: 34, clientVersion: '0.14.0' },
      });

      expect(session).toEqual(
        expect.objectContaining({
          libraryItemId: 'li-30',
          playMethod: 0,
          currentTime: 630,
          startTime: 630,
          duration: 1_500,
          mediaPlayer: 'exo-player',
          userId: 'usr-7',
        }),
      );
      expect(session.audioTracks).toHaveLength(2);
      expect(session.deviceInfo).toEqual(expect.objectContaining({ deviceId: 'abc', model: 'Pixel', sdkVersion: 34 }));
      expect(verifyPlaybackSessionId(SECRET, session.id)).toEqual(
        expect.objectContaining({ bookId: 30, userId: 7, authSessionId: 12, authMethod: 'password' }),
      );
    });

    it('starts a finished book over', async () => {
      const { service, audiobookService } = setup();
      audiobookService.getPlaybackState.mockResolvedValue(state({ completed: true, percentage: 100 }));

      const session = await service.play(makeUser(), 'li-30', {});

      expect(session.currentTime).toBe(0);
    });

    it('starts at zero with no stored position and tolerates an empty body', async () => {
      const { service, audiobookService } = setup();
      audiobookService.getPlaybackState.mockResolvedValue(null);

      const session = await service.play(makeUser(), 'li-30', undefined);

      expect(session.currentTime).toBe(0);
      expect(session.mediaPlayer).toBe('unknown');
    });
  });
});
