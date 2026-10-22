import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { encodePlaybackSessionId } from '../abs-ids';
import { makeUser } from '../abs-test-support';
import { AbsMediaService } from './abs-media.service';

const SECRET = 'secret';
const FILE_A = { id: 11, publicId: 'a-id', bookId: 30, absolutePath: '/library/Part 1.mp3', sortOrder: 1 };
const FILE_B = { id: 12, publicId: 'b-id', bookId: 30, absolutePath: '/library/Part 2.mp3', sortOrder: 2 };

function setup(options: { anonymousCovers?: string; coverFileCount?: number } = {}) {
  const asset = { absolutePath: '/library/Part 2.mp3', format: 'mp3', sizeBytes: 2_000 };
  const audiobookService = { getAsset: vi.fn().mockResolvedValue(asset) };
  const bookService = { getCoverPath: vi.fn().mockResolvedValue('/covers/30.jpg') };
  const coverStore = { resolve: vi.fn().mockResolvedValue('/covers/anon.jpg') };
  const repo = {
    findTimelineFiles: vi.fn().mockResolvedValue([FILE_B, FILE_A]),
    findItemFacts: vi.fn().mockResolvedValue(new Map([[30, { fileCount: options.coverFileCount ?? 2 }]])),
  };
  const absAuth = { verifySessionCapability: vi.fn().mockResolvedValue(makeUser(7)) };
  const config = { get: vi.fn().mockReturnValue(options.anonymousCovers) };
  const service = new AbsMediaService(
    audiobookService as never,
    bookService as never,
    coverStore as never,
    repo as never,
    absAuth as never,
    config as never,
    { jwtSecret: SECRET } as never,
  );
  return { service, audiobookService, bookService, coverStore, repo, absAuth, asset };
}

const sessionId = (overrides: Record<string, unknown> = {}) =>
  encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password', ...overrides });

describe('AbsMediaService', () => {
  describe('files', () => {
    it('resolves a file by its public id through the access checked asset lookup', async () => {
      const { service, audiobookService, asset } = setup();
      const user = makeUser();

      await expect(service.resolveFile(user, 'li-30', 'b-id')).resolves.toBe(asset);

      expect(audiobookService.getAsset).toHaveBeenCalledWith(30, 'aud_b-id', user);
    });

    it('rejects a malformed item id before touching any file', async () => {
      const { service, audiobookService } = setup();

      await expect(service.resolveFile(makeUser(), 'not-an-item', 'b-id')).rejects.toThrow(NotFoundException);
      expect(audiobookService.getAsset).not.toHaveBeenCalled();
    });
  });

  describe('covers', () => {
    it('checks access for a request that carries a user', async () => {
      const { service, bookService, coverStore } = setup();
      const user = makeUser();

      await expect(service.resolveCover('li-30', user)).resolves.toBe('/covers/30.jpg');

      expect(bookService.getCoverPath).toHaveBeenCalledWith(30, user, { medium: 'audio' });
      expect(coverStore.resolve).not.toHaveBeenCalled();
    });

    it('serves an audiobook cover to a request with no credentials, as the apps expect', async () => {
      const { service, coverStore, bookService } = setup();

      await expect(service.resolveCover('li-30', null)).resolves.toBe('/covers/anon.jpg');

      expect(coverStore.resolve).toHaveBeenCalledWith(30, { variant: 'cover', medium: 'audio' });
      expect(bookService.getCoverPath).not.toHaveBeenCalled();
    });

    it('does not serve anonymous covers for books without audio files', async () => {
      const { service, coverStore } = setup({ coverFileCount: 0 });

      await expect(service.resolveCover('li-30', null)).rejects.toThrow(NotFoundException);
      expect(coverStore.resolve).not.toHaveBeenCalled();
    });

    it.each(['false', '0', 'off', ' NO '])('can switch anonymous covers off with %j', async (value) => {
      const { service, coverStore } = setup({ anonymousCovers: value });

      await expect(service.resolveCover('li-30', null)).rejects.toThrow(NotFoundException);
      expect(coverStore.resolve).not.toHaveBeenCalled();
    });

    it('reports a missing cover as not found', async () => {
      const { service, bookService } = setup();
      bookService.getCoverPath.mockResolvedValue(null);

      await expect(service.resolveCover('li-30', makeUser())).rejects.toThrow(NotFoundException);
    });
  });

  describe('session tracks', () => {
    it('serves the track a signed session id names, in playback order', async () => {
      const { service, audiobookService, absAuth } = setup();

      await service.resolveSessionTrack(sessionId(), 2);

      expect(absAuth.verifySessionCapability).toHaveBeenCalledWith(expect.objectContaining({ bookId: 30, userId: 7, authSessionId: 3 }));
      expect(audiobookService.getAsset).toHaveBeenCalledWith(30, 'aud_b-id', expect.objectContaining({ id: 7 }));
    });

    it('serves track one as the first file', async () => {
      const { service, audiobookService } = setup();

      await service.resolveSessionTrack(sessionId(), 1);

      expect(audiobookService.getAsset).toHaveBeenCalledWith(30, 'aud_a-id', expect.anything());
    });

    it.each([0, 3, -1, 1.5])('has no track %s', async (index) => {
      const { service, audiobookService } = setup();

      await expect(service.resolveSessionTrack(sessionId(), index)).rejects.toThrow(NotFoundException);
      expect(audiobookService.getAsset).not.toHaveBeenCalled();
    });

    it('refuses a forged or altered session id before any lookup', async () => {
      const { service, absAuth, repo } = setup();
      const forged = sessionId().replace('ps-30-', 'ps-31-');

      await expect(service.resolveSessionTrack(forged, 1)).rejects.toThrow(NotFoundException);
      await expect(service.resolveSessionTrack('play_local_1', 1)).rejects.toThrow(NotFoundException);
      expect(absAuth.verifySessionCapability).not.toHaveBeenCalled();
      expect(repo.findTimelineFiles).not.toHaveBeenCalled();
    });

    it('refuses once the sign-in behind the session is gone', async () => {
      const { service, absAuth, audiobookService } = setup();
      absAuth.verifySessionCapability.mockRejectedValue(new UnauthorizedException());

      await expect(service.resolveSessionTrack(sessionId(), 1)).rejects.toThrow(UnauthorizedException);
      expect(audiobookService.getAsset).not.toHaveBeenCalled();
    });
  });
});
