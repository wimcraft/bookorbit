import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import { AbsApiController } from './controllers/abs-api.controller';
import { AbsFallbackController } from './controllers/abs-fallback.controller';
import { AbsMediaController } from './controllers/abs-media.controller';
import { AbsRootController } from './controllers/abs-root.controller';
import { AbsMediaTokenGuard } from './guards/abs-media-token.guard';
import { makeUser } from './abs-test-support';
import { AbsAuthService } from './services/abs-auth.service';
import { AbsItemService } from './services/abs-item.service';
import { AbsLibraryService } from './services/abs-library.service';
import { AbsMediaService } from './services/abs-media.service';

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
  };
  const itemService = { getExpanded: vi.fn().mockResolvedValue({ id: 'li-30' }), play: vi.fn().mockResolvedValue({ id: 'ps-30' }) };
  const mediaService = {
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
      controllers: [AbsRootController, AbsApiController, AbsMediaController, AbsFallbackController],
      providers: [
        { provide: APP_GUARD, useClass: StubJwtGuard },
        { provide: AbsAuthService, useValue: authService },
        { provide: AbsLibraryService, useValue: libraryService },
        { provide: AbsItemService, useValue: itemService },
        { provide: AbsMediaService, useValue: mediaService },
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
      expect((await get('/api/items/li-30?expanded=1&include=progress', auth)).json()).toEqual({ id: 'li-30' });
      expect(itemService.getExpanded).toHaveBeenCalledWith(expect.anything(), 'li-30');
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
