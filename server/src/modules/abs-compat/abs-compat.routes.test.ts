import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import { AbsApiController } from './controllers/abs-api.controller';
import { AbsFallbackController } from './controllers/abs-fallback.controller';
import { AbsMediaController } from './controllers/abs-media.controller';
import { AbsRootController } from './controllers/abs-root.controller';
import { AbsSessionController } from './controllers/abs-session.controller';
import { AbsMediaTokenGuard } from './guards/abs-media-token.guard';
import { makeUser } from './abs-test-support';
import { AbsAuthService } from './services/abs-auth.service';
import { AbsBookmarkService } from './services/abs-bookmark.service';
import { AbsBrowseService } from './services/abs-browse.service';
import { AbsItemService } from './services/abs-item.service';
import { AbsLibraryService } from './services/abs-library.service';
import { AbsMediaService } from './services/abs-media.service';
import { AbsProgressService } from './services/abs-progress.service';
import { AbsSessionService } from './services/abs-session.service';

const BEARER = 'good-bearer';

@Injectable()
class StubJwtGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    if (request.headers.authorization !== `Bearer ${BEARER}`) throw new UnauthorizedException();
    request.user = makeUser(7);
    return true;
  }
}

describe('ABS compat routes', () => {
  let app: NestFastifyApplication;
  let dir: string;
  const audioBytes = Buffer.from('0123456789abcdefghij');

  const authService = {
    login: vi.fn().mockResolvedValue({ user: { id: 'usr-7' } }),
    refresh: vi.fn().mockResolvedValue({ user: { id: 'usr-7' } }),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({ id: 'usr-7' }),
    authorize: vi.fn().mockResolvedValue({ user: { id: 'usr-7' } }),
    verifyMediaToken: vi.fn((token: string) =>
      token === 'media-token' ? Promise.resolve(makeUser(7)) : Promise.reject(new UnauthorizedException()),
    ),
  };
  const libraryService = {
    listLibraries: vi.fn().mockResolvedValue([{ id: 'lib-3' }]),
    getLibrary: vi.fn().mockResolvedValue({ id: 'lib-3' }),
    filterData: vi.fn().mockReturnValue({ numIssues: 0 }),
    listItems: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    personalized: vi.fn().mockResolvedValue([]),
    itemsInProgress: vi.fn().mockResolvedValue([]),
  };
  const itemService = { getExpanded: vi.fn().mockResolvedValue({ id: 'li-30' }), play: vi.fn().mockResolvedValue({ id: 'ps-30' }) };
  const progressService = {
    getOne: vi.fn().mockResolvedValue({ id: 'mp-30' }),
    patchOne: vi.fn().mockResolvedValue(undefined),
    patchBatch: vi.fn().mockResolvedValue({ applied: 1, failed: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const sessionService = {
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    syncLocal: vi.fn().mockResolvedValue({ id: 'x', success: true }),
    syncLocalAll: vi.fn().mockResolvedValue({ results: [{ id: 'x', success: true, progressSynced: true }] }),
    getOpenSession: vi.fn(() => {
      throw new NotFoundException('Session not found');
    }),
  };
  const browseService = {
    listSeries: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    getSeries: vi.fn().mockResolvedValue({ id: 'ser-1' }),
    listAuthors: vi.fn().mockResolvedValue({ authors: [] }),
    getAuthor: vi.fn().mockResolvedValue({ id: 'aut-5' }),
    search: vi.fn().mockResolvedValue({ book: [] }),
  };
  const bookmarkService = {
    create: vi.fn().mockResolvedValue({ libraryItemId: 'li-30', title: 'Mark', time: 12, createdAt: 1 }),
    update: vi.fn().mockResolvedValue({ libraryItemId: 'li-30', title: 'Renamed', time: 12, createdAt: 1 }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const mediaService = {
    resolveAuthorImage: vi.fn(),
    resolveCover: vi.fn(),
    resolveFile: vi.fn(),
    resolveSessionTrack: vi.fn(),
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abs-routes-'));
    await writeFile(join(dir, 'Part 1.mp3'), audioBytes);
    await writeFile(join(dir, 'cover.jpg'), Buffer.from('jpegdata'));
    const asset = { absolutePath: join(dir, 'Part 1.mp3'), format: 'mp3', sizeBytes: audioBytes.length };
    mediaService.resolveFile.mockResolvedValue(asset);
    mediaService.resolveSessionTrack.mockResolvedValue(asset);
    mediaService.resolveCover.mockResolvedValue(join(dir, 'cover.jpg'));

    const moduleRef = await Test.createTestingModule({
      controllers: [AbsRootController, AbsApiController, AbsSessionController, AbsMediaController, AbsFallbackController],
      providers: [
        { provide: APP_GUARD, useClass: StubJwtGuard },
        { provide: AbsAuthService, useValue: authService },
        { provide: AbsLibraryService, useValue: libraryService },
        { provide: AbsItemService, useValue: itemService },
        { provide: AbsProgressService, useValue: progressService },
        { provide: AbsSessionService, useValue: sessionService },
        { provide: AbsMediaService, useValue: mediaService },
        { provide: AbsBrowseService, useValue: browseService },
        { provide: AbsBookmarkService, useValue: bookmarkService },
        AbsMediaTokenGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${BEARER}` };
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/v1/abs${url}`, headers });

  describe('connect', () => {
    it('answers status and ping without credentials', async () => {
      const status = await get('/status');
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        app: 'audiobookshelf',
        serverVersion: '2.26.0',
        isInit: true,
        language: 'en-us',
        authMethods: ['local'],
        authFormData: {},
      });

      const ping = await get('/ping');
      expect(ping.json()).toEqual({ success: true });
    });

    it('accepts the login body the apps send, including fields BookOrbit does not know', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/login',
        headers: { 'x-return-tokens': 'true' },
        payload: { username: 'u', password: 'p', extra: 'ignored' },
      });

      expect(response.statusCode).toBe(200);
      expect(authService.login).toHaveBeenCalledWith({ username: 'u', password: 'p', extra: 'ignored' }, expect.anything(), expect.anything());
    });

    it('logs out and refreshes without a bearer token', async () => {
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/abs/auth/refresh', headers: { 'x-refresh-token': 'a' }, payload: {} })).statusCode,
      ).toBe(200);
      const logout = await app.inject({ method: 'POST', url: '/api/v1/abs/logout', payload: {} });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ redirect_url: null });
    });
  });

  describe('authenticated api', () => {
    it('refuses calls without the bearer token', async () => {
      expect((await get('/api/me')).statusCode).toBe(401);
      expect((await get('/api/libraries')).statusCode).toBe(401);
      expect((await get('/api/items/li-30')).statusCode).toBe(401);
    });

    it('routes the browse endpoints', async () => {
      expect((await get('/api/me', auth)).json()).toEqual({ id: 'usr-7' });
      expect((await get('/api/libraries?include=stats', auth)).json()).toEqual({ libraries: [{ id: 'lib-3' }] });
      expect(libraryService.listLibraries).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), true);
      expect((await get('/api/libraries/lib-3', auth)).json()).toEqual({ id: 'lib-3' });
      expect((await get('/api/libraries/lib-3?include=filterdata', auth)).json()).toEqual({
        filterdata: { numIssues: 0 },
        issues: 0,
        numUserPlaylists: 0,
        library: { id: 'lib-3' },
      });
      await get('/api/libraries/lib-3/items?limit=25&page=2&sort=addedAt&desc=1&minified=1&filter=unknown.thing', auth);
      expect(libraryService.listItems).toHaveBeenCalledWith(expect.anything(), 'lib-3', {
        limit: 25,
        page: 2,
        sort: 'addedAt',
        desc: true,
        filter: 'unknown.thing',
        minified: true,
      });
      expect((await get('/api/libraries/lib-3/personalized?minified=1', auth)).json()).toEqual([]);
      expect((await get('/api/me/items-in-progress', auth)).json()).toEqual({ libraryItems: [] });
      expect((await get('/api/items/li-30?expanded=1&include=progress', auth)).json()).toEqual({ id: 'li-30' });
      expect(itemService.getExpanded).toHaveBeenCalledWith(expect.anything(), 'li-30', true);
    });

    it('starts a play session from the body the apps send', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/api/items/li-30/play',
        headers: auth,
        payload: {
          deviceInfo: { deviceId: 'd', sdkVersion: 34 },
          mediaPlayer: 'exo-player',
          forceDirectPlay: true,
          forceTranscode: false,
          supportedMimeTypes: ['audio/mpeg'],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 'ps-30' });
      expect(itemService.play).toHaveBeenCalledWith(expect.anything(), 'li-30', expect.objectContaining({ mediaPlayer: 'exo-player' }));
    });
  });

  describe('progress and sessions', () => {
    it('answers plain OK text where the apps cannot parse an empty body', async () => {
      const sync = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/api/session/ps-30-x/sync',
        headers: auth,
        payload: { currentTime: 3, timeListened: 2, duration: 30 },
      });
      expect(sync.statusCode).toBe(200);
      expect(sync.body).toBe('OK');
      expect(sync.headers['content-type']).toContain('text/plain');
      expect(sessionService.sync).toHaveBeenCalledWith(
        expect.anything(),
        'ps-30-x',
        { currentTime: 3, timeListened: 2, duration: 30 },
        'lightMyRequest',
      );

      const close = await app.inject({ method: 'POST', url: '/api/v1/abs/api/session/ps-30-x/close', headers: auth, payload: {} });
      expect(close.body).toBe('OK');

      const local = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/api/session/local',
        headers: auth,
        payload: { id: 'play_local_1', libraryItemId: 'li-30', currentTime: 1, updatedAt: 1, deviceInfo: { a: 1 } },
      });
      expect(local.body).toBe('OK');
    });

    it('answers a real 404 with a JSON body on the routes that answer OK as text', async () => {
      progressService.remove.mockRejectedValueOnce(new NotFoundException('Progress not found'));
      bookmarkService.remove.mockRejectedValueOnce(new NotFoundException('Bookmark not found'));
      sessionService.syncLocal.mockRejectedValueOnce(new NotFoundException('Media item not found'));

      for (const [method, url, payload] of [
        ['DELETE', '/api/v1/abs/api/me/progress/mp-30', undefined],
        ['DELETE', '/api/v1/abs/api/me/item/li-30/bookmark/99', undefined],
        ['POST', '/api/v1/abs/api/session/local', { id: 'play_local_1', libraryItemId: 'li-999' }],
      ] as const) {
        const res = await app.inject({ method, url, headers: auth, payload });
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toContain('application/json');
      }
    });

    it('returns per entry results for local-all', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/api/session/local-all',
        headers: auth,
        payload: { sessions: [{ id: 'x', libraryItemId: 'li-30' }], deviceInfo: {} },
      });

      expect(response.json()).toEqual({ results: [{ id: 'x', success: true, progressSynced: true }] });
    });

    it('reports an open session as missing', async () => {
      expect((await get('/api/session/ps-30-x', auth)).statusCode).toBe(404);
    });

    it('routes progress reads and writes, with the batch route not mistaken for an id', async () => {
      expect((await get('/api/me/progress/li-30', auth)).json()).toEqual({ id: 'mp-30' });

      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/abs/api/me/progress/li-30',
        headers: auth,
        payload: { currentTime: 5, duration: 30, progress: 0.1, isFinished: false },
      });
      expect(patch.body).toBe('OK');
      expect(progressService.patchOne).toHaveBeenCalledWith(expect.anything(), 'li-30', {
        currentTime: 5,
        duration: 30,
        progress: 0.1,
        isFinished: false,
      });

      const batch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/abs/api/me/progress/batch/update',
        headers: auth,
        payload: [{ libraryItemId: 'li-30', currentTime: 5 }],
      });
      expect(batch.body).toBe('OK');
      expect(progressService.patchBatch).toHaveBeenCalledWith(expect.anything(), [{ libraryItemId: 'li-30', currentTime: 5 }]);
      expect(progressService.patchOne).toHaveBeenCalledTimes(1);

      const remove = await app.inject({ method: 'DELETE', url: '/api/v1/abs/api/me/progress/mp-30', headers: auth });
      expect(remove.body).toBe('OK');
      expect(progressService.remove).toHaveBeenCalledWith(expect.anything(), 'mp-30');
    });
  });

  describe('media', () => {
    const fileUrl = '/api/items/li-30/file/b-id';

    it('requires a valid token on the file routes', async () => {
      expect((await get(fileUrl)).statusCode).toBe(401);
      expect((await get(`${fileUrl}?token=wrong`)).statusCode).toBe(401);
      expect((await get(`${fileUrl}/download`)).statusCode).toBe(401);
    });

    it('streams the whole file for a query token', async () => {
      const response = await get(`${fileUrl}?token=media-token`);

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(audioBytes)).toBe(true);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-type']).toBe('audio/mpeg');
      expect(response.headers['content-length']).toBe(String(audioBytes.length));
      expect(response.headers['content-disposition']).toContain('inline');
    });

    it('serves byte ranges so players can seek', async () => {
      const response = await get(`${fileUrl}?token=media-token`, { range: 'bytes=5-9' });

      expect(response.statusCode).toBe(206);
      expect(response.rawPayload.toString()).toBe('56789');
      expect(response.headers['content-range']).toBe(`bytes 5-9/${audioBytes.length}`);

      const open = await get(`${fileUrl}?token=media-token`, { range: 'bytes=15-' });
      expect(open.statusCode).toBe(206);
      expect(open.rawPayload.toString()).toBe('fghij');

      const oversize = await get(`${fileUrl}?token=media-token`, { range: 'bytes=15-9999' });
      expect(oversize.statusCode).toBe(206);
      expect(oversize.headers['content-range']).toBe(`bytes 15-19/${audioBytes.length}`);

      const outside = await get(`${fileUrl}?token=media-token`, { range: 'bytes=40-' });
      expect(outside.statusCode).toBe(416);
      expect(outside.headers['content-range']).toBe(`bytes */${audioBytes.length}`);
    });

    it('offers a download with an attachment disposition', async () => {
      const response = await get(`${fileUrl}/download?token=media-token`);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('Part 1.mp3');
    });

    it('routes series, authors, search and the empty collection lists', async () => {
      await get('/api/libraries/lib-3/series?minified=1&sort=name&limit=10000', auth);
      expect(browseService.listSeries).toHaveBeenLastCalledWith(expect.anything(), 'lib-3', expect.objectContaining({ limit: 500, sort: 'name' }));
      expect((await get('/api/series/ser-1', auth)).json()).toEqual({ id: 'ser-1' });
      expect(browseService.getSeries).toHaveBeenLastCalledWith(expect.anything(), 'ser-1');
      await get('/api/libraries/lib-3/series/ser-1', auth);
      expect(browseService.getSeries).toHaveBeenLastCalledWith(expect.anything(), 'ser-1', 'lib-3');
      expect((await get('/api/libraries/lib-3/authors', auth)).json()).toEqual({ authors: [] });
      expect((await get('/api/authors/aut-5', auth)).json()).toEqual({ id: 'aut-5' });
      await get('/api/libraries/lib-3/search?q=saga&limit=5', auth);
      expect(browseService.search).toHaveBeenLastCalledWith(expect.anything(), 'lib-3', 'saga', '5');
      for (const list of ['collections?minified=1&sort=name&limit=1000', 'playlists']) {
        expect((await get(`/api/libraries/lib-3/${list}`, auth)).json()).toEqual({ results: [], total: 0, limit: 0, page: 0 });
      }
    });

    it('routes bookmarks with the bodies the apps send', async () => {
      const post = await app.inject({
        method: 'POST',
        url: '/api/v1/abs/api/me/item/li-30/bookmark',
        headers: auth,
        payload: { time: 12, title: 'Mark', libraryItemId: 'li-30' },
      });
      expect(post.statusCode).toBe(200);
      expect(post.json()).toEqual(expect.objectContaining({ title: 'Mark', time: 12 }));
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/abs/api/me/item/li-30/bookmark',
        headers: auth,
        payload: { time: 12, title: 'Renamed' },
      });
      expect(patch.json()).toEqual(expect.objectContaining({ title: 'Renamed' }));
      const removed = await app.inject({ method: 'DELETE', url: '/api/v1/abs/api/me/item/li-30/bookmark/12.5', headers: auth });
      expect(removed.body).toBe('OK');
      expect(bookmarkService.remove).toHaveBeenCalledWith(expect.anything(), 'li-30', '12.5');
    });

    it('serves author images with and without credentials', async () => {
      mediaService.resolveAuthorImage.mockResolvedValue(join(dir, 'cover.jpg'));

      expect((await get('/api/authors/aut-5/image')).statusCode).toBe(200);
      expect(mediaService.resolveAuthorImage).toHaveBeenLastCalledWith('aut-5', null);
      expect((await get('/api/authors/aut-5/image?token=media-token')).statusCode).toBe(200);
      expect(mediaService.resolveAuthorImage).toHaveBeenLastCalledWith('aut-5', expect.objectContaining({ id: 7 }));
      expect((await get('/api/authors/aut-5/image?token=wrong')).statusCode).toBe(401);
    });

    it('serves covers with and without credentials', async () => {
      const anonymous = await get('/api/items/li-30/cover?ts=123');
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.headers['content-type']).toBe('image/jpeg');
      expect(mediaService.resolveCover).toHaveBeenLastCalledWith('li-30', null);

      const authed = await get('/api/items/li-30/cover?token=media-token');
      expect(authed.statusCode).toBe(200);
      expect(mediaService.resolveCover).toHaveBeenLastCalledWith('li-30', expect.objectContaining({ id: 7 }));

      expect((await get('/api/items/li-30/cover?token=wrong')).statusCode).toBe(401);

      const cached = await get('/api/items/li-30/cover', { 'if-none-match': String(anonymous.headers.etag) });
      expect(cached.statusCode).toBe(304);
    });

    it('serves a session track with no credentials in the request', async () => {
      const response = await get('/public/session/ps-30-session/track/1', { range: 'bytes=0-3' });

      expect(response.statusCode).toBe(206);
      expect(response.rawPayload.toString()).toBe('0123');
      expect(mediaService.resolveSessionTrack).toHaveBeenCalledWith('ps-30-session', 1);
    });
  });

  describe('unsupported routes', () => {
    it('answers 404 and logs the route with the token stripped', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const response = await get('/api/me/listening-stats?token=eyJsecret.value.sig', { 'user-agent': 'SoundLeaf/1.0' });

      expect(response.statusCode).toBe(404);
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        '[abs.unsupported_route] method=GET path="/api/v1/abs/api/me/listening-stats" userAgent="SoundLeaf/1.0" - route not supported',
      );
      expect(lines.join('\n')).not.toContain('secret');
      warn.mockRestore();
    });

    it('does not shadow a real route', async () => {
      expect((await get('/ping')).statusCode).toBe(200);
      expect((await get('/api/libraries', auth)).statusCode).toBe(200);
    });
  });
});
