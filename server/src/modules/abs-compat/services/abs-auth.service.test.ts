import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { makeUser } from '../abs-test-support';
import { AbsAuthService } from './abs-auth.service';

const SECRET = 'a-test-secret-that-is-long-enough';
const REFRESH_TOKEN = 'ab'.repeat(32);
const NEW_REFRESH_TOKEN = 'cd'.repeat(32);

const jwt = new JwtService({});
const sign = (payload: Record<string, unknown>, secret = SECRET, options: Record<string, unknown> = {}) => jwt.sign(payload, { secret, ...options });
const expiredAt = () => Math.floor(Date.now() / 1000) - 3600;

function makeRequest(headers: Record<string, string> = {}) {
  return { headers: { 'user-agent': 'okhttp/4.12.0', ...headers }, ip: '203.0.113.9', cookies: {} } as never;
}

function setup(
  sessionStore: { sessionId: number; tokenVersion: number; method: string } | null = { sessionId: 3, tokenVersion: 1, method: 'password' },
) {
  const user = makeUser(7);
  const accessToken = sign({ sub: 7, ver: 1, sid: 3, amr: 'password' }, SECRET, { expiresIn: '15m' });
  const authService = {
    login: vi.fn().mockResolvedValue({
      accessToken,
      accessTokenExpiresAt: new Date().toISOString(),
      refreshToken: REFRESH_TOKEN,
      refreshTokenExpiresAt: new Date().toISOString(),
      sessionId: 3,
      user: { id: 7, username: 'listener7' },
    }),
    refresh: vi.fn().mockResolvedValue({
      accessToken,
      accessTokenExpiresAt: new Date().toISOString(),
      refreshToken: NEW_REFRESH_TOKEN,
      refreshTokenExpiresAt: new Date().toISOString(),
      sessionId: 3,
    }),
    logout: vi.fn().mockResolvedValue({}),
    findActingUser: vi.fn().mockResolvedValue(user),
    validateSessionUser: vi.fn((userId: number, tokenVersion: number, method: string, sessionId?: number) => {
      const active =
        sessionStore && sessionStore.sessionId === sessionId && sessionStore.tokenVersion === tokenVersion && sessionStore.method === method;
      if (!active || userId !== 7) return Promise.reject(new UnauthorizedException());
      return Promise.resolve({ ...user, sessionId, authenticationMethod: method });
    }),
  };
  const progressService = { listForUser: vi.fn().mockResolvedValue([]) };
  const libraryService = { accessibleBookLibraryIds: vi.fn().mockResolvedValue([3, 5]) };
  const service = new AbsAuthService(authService as never, jwt, progressService as never, libraryService as never, { jwtSecret: SECRET } as never);
  const logLines = () => [
    ...vi.mocked(service['logger'].log).mock.calls.map(([line]) => String(line)),
    ...vi.mocked(service['logger'].warn).mock.calls.map(([line]) => String(line)),
  ];
  vi.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return { service, authService, progressService, libraryService, accessToken, user, logLines };
}

describe('AbsAuthService', () => {
  describe('login', () => {
    it('delegates to the normal login as a native session labelled by device', async () => {
      const { service, authService, accessToken } = setup();
      const reply = {} as never;

      const payload = await service.login({ username: 'listener7', password: 'hunter2' }, makeRequest({ 'x-return-tokens': 'true' }), reply);

      expect(authService.login).toHaveBeenCalledWith(
        { username: 'listener7', password: 'hunter2', clientKind: 'native', deviceLabel: 'Audiobookshelf app (Android)' },
        reply,
        '203.0.113.9',
      );
      expect(payload.user).toEqual(
        expect.objectContaining({
          id: 'usr-7',
          username: 'listener7',
          type: 'user',
          accessToken,
          refreshToken: REFRESH_TOKEN,
          token: accessToken,
          librariesAccessible: ['lib-3', 'lib-5'],
        }),
      );
      expect(payload).toEqual(expect.objectContaining({ userDefaultLibraryId: 'lib-3', ereaderDevices: [], Source: 'docker' }));
      expect(payload.serverSettings).toEqual(expect.objectContaining({ id: 'server-settings', version: '2.26.0', language: 'en-us' }));
    });

    it('labels SoundLeaf sessions', async () => {
      const { service, authService } = setup();

      await service.login({ username: 'u', password: 'p' }, makeRequest({ 'user-agent': 'SoundLeaf/1.2 CFNetwork Darwin' }), {} as never);

      expect(authService.login).toHaveBeenCalledWith(
        expect.objectContaining({ deviceLabel: 'SoundLeaf (iOS)' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('leaves the refresh token out unless the client asked for tokens in the body', async () => {
      const { service } = setup();

      const payload = await service.login({ username: 'u', password: 'p' }, makeRequest(), {} as never);

      expect(payload.user.refreshToken).toBeNull();
      expect(payload.user.accessToken).toBeTruthy();
    });

    it('refuses a wrong password, an OIDC-only account and a locked account by passing the 401 through', async () => {
      const { service, authService } = setup();
      authService.login.mockRejectedValue(new UnauthorizedException('Invalid credentials'));

      await expect(service.login({ username: 'u', password: 'wrong' }, makeRequest(), {} as never)).rejects.toThrow(UnauthorizedException);
    });

    it.each([
      [{}],
      [{ username: 'u' }],
      [{ password: 'p' }],
      [{ username: '', password: 'p' }],
      [{ username: 'u', password: 5 }],
      [{ username: 'x'.repeat(101), password: 'p' }],
      [null],
    ])('rejects the malformed body %j without calling the credential check', async (body) => {
      const { service, authService } = setup();

      await expect(service.login(body, makeRequest(), {} as never)).rejects.toThrow(UnauthorizedException);
      expect(authService.login).not.toHaveBeenCalled();
    });

    it('logs start, end and fail without credentials, tokens or the username', async () => {
      const { service, authService, logLines } = setup();
      await service.login({ username: 'listener7', password: 'hunter2' }, makeRequest({ 'x-return-tokens': 'true' }), {} as never);
      authService.login.mockRejectedValueOnce(new UnauthorizedException('Invalid credentials'));
      await service.login({ username: 'listener7', password: 'hunter2' }, makeRequest(), {} as never).catch(() => undefined);

      const lines = logLines();
      expect(lines[0]).toBe('[abs.login] [start] ip=203.0.113.9 deviceLabel="Audiobookshelf app (Android)" - login started');
      expect(lines[1]).toMatch(/^\[abs\.login\] \[end\] userId=7 durationMs=\d+ returnTokens=true - login completed$/);
      expect(
        lines.some((line) =>
          /^\[abs\.login\] \[fail\] durationMs=\d+ errorClass=UnauthorizedException error="Invalid credentials" - login failed$/.test(line),
        ),
      ).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain('hunter2');
        expect(line).not.toContain('listener7');
        expect(line).not.toContain(REFRESH_TOKEN);
        expect(line).not.toContain('eyJ');
      }
    });
  });

  describe('refresh', () => {
    it('rotates through the native refresh path and returns the new tokens', async () => {
      const { service, authService } = setup();
      const req = makeRequest({ 'x-refresh-token': REFRESH_TOKEN });
      const reply = {} as never;

      const payload = await service.refresh(req, reply);

      expect(authService.refresh).toHaveBeenCalledWith(req, reply, { refreshToken: REFRESH_TOKEN });
      expect(payload.user).toEqual(expect.objectContaining({ id: 'usr-7', refreshToken: NEW_REFRESH_TOKEN }));
      expect(payload.user.accessToken).toBeTruthy();
    });

    it.each([[undefined], [''], ['not-hex'], ['AB'.repeat(32)], ['ab'.repeat(31)]])(
      'rejects the refresh token %j without trying it',
      async (token) => {
        const { service, authService } = setup();
        const headers: Record<string, string> = token === undefined ? {} : { 'x-refresh-token': token };

        await expect(service.refresh(makeRequest(headers), {} as never)).rejects.toThrow(UnauthorizedException);
        expect(authService.refresh).not.toHaveBeenCalled();
      },
    );

    it('fails with 401 when the refresh token is not accepted, and never logs it', async () => {
      const { service, authService, logLines } = setup();
      authService.refresh.mockRejectedValue(new UnauthorizedException());

      await expect(service.refresh(makeRequest({ 'x-refresh-token': REFRESH_TOKEN }), {} as never)).rejects.toThrow(UnauthorizedException);

      for (const line of logLines()) expect(line).not.toContain(REFRESH_TOKEN);
      expect(logLines().some((line) => line.startsWith('[abs.refresh] [fail]'))).toBe(true);
    });
  });

  describe('logout', () => {
    it('revokes the session of the refresh token and ignores a missing or broken one', async () => {
      const { service, authService } = setup();

      await service.logout(makeRequest({ 'x-refresh-token': REFRESH_TOKEN }), {} as never);
      expect(authService.logout).toHaveBeenCalledWith(expect.anything(), expect.anything(), { refreshToken: REFRESH_TOKEN });

      authService.logout.mockClear();
      await service.logout(makeRequest(), {} as never);
      await service.logout(makeRequest({ 'x-refresh-token': 'junk' }), {} as never);
      expect(authService.logout).not.toHaveBeenCalled();

      authService.logout.mockRejectedValue(new Error('db down'));
      await expect(service.logout(makeRequest({ 'x-refresh-token': REFRESH_TOKEN }), {} as never)).resolves.toBeUndefined();
    });
  });

  describe('me and authorize', () => {
    it('describes the user without minting tokens', async () => {
      const { service, progressService } = setup();
      progressService.listForUser.mockResolvedValue([{ id: 'mp-30' }]);

      const me = await service.me(makeUser(7, { isSuperuser: true, email: 'a@b.c' }), 'bearer-value');
      const authorize = await service.authorize(makeUser(7), null);

      expect(me).toEqual(
        expect.objectContaining({
          id: 'usr-7',
          type: 'admin',
          email: 'a@b.c',
          token: 'bearer-value',
          mediaProgress: [{ id: 'mp-30' }],
          seriesHideFromContinueListening: [],
          bookmarks: [],
        }),
      );
      expect(me.permissions).toEqual(
        expect.objectContaining({ download: true, update: false, delete: false, upload: false, accessAllLibraries: true }),
      );
      expect(me).not.toHaveProperty('accessToken');
      expect(authorize.user).not.toHaveProperty('refreshToken');
      expect(authorize.userDefaultLibraryId).toBe('lib-3');
    });
  });

  describe('media tokens', () => {
    it('accepts an expired token while its session is still active', async () => {
      const { service, authService, user } = setup();
      const token = sign({ sub: 7, ver: 1, sid: 3, amr: 'password', exp: expiredAt() });

      await expect(service.verifyMediaToken(token)).resolves.toEqual(expect.objectContaining({ id: user.id, sessionId: 3 }));
      expect(authService.validateSessionUser).toHaveBeenCalledWith(7, 1, 'password', 3);
    });

    it('refuses a token whose session was revoked', async () => {
      const { service } = setup(null);
      const token = sign({ sub: 7, ver: 1, sid: 3, amr: 'password', exp: expiredAt() });

      await expect(service.verifyMediaToken(token)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a token from before a token version bump', async () => {
      const { service } = setup({ sessionId: 3, tokenVersion: 2, method: 'password' });
      const token = sign({ sub: 7, ver: 1, sid: 3, amr: 'password' }, SECRET, { expiresIn: '15m' });

      await expect(service.verifyMediaToken(token)).rejects.toThrow(UnauthorizedException);
    });

    it('treats a token without an auth method as a legacy sign-in', async () => {
      const { service, authService } = setup({ sessionId: 3, tokenVersion: 1, method: 'legacy' });

      await service.verifyMediaToken(sign({ sub: 7, ver: 1, sid: 3 }, SECRET, { expiresIn: '1h' }));

      expect(authService.validateSessionUser).toHaveBeenCalledWith(7, 1, 'legacy', 3);
    });

    it.each([
      ['a token signed with another secret', () => sign({ sub: 7, ver: 1, sid: 3, amr: 'password' }, 'another-secret-entirely-different')],
      [
        'an unsigned token',
        () => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":7,"ver":1,"sid":3}').toString('base64url')}.`,
      ],
      ['a token without a session', () => sign({ sub: 7, ver: 1, amr: 'password' })],
      ['a token with a non numeric subject', () => sign({ sub: '7', ver: 1, sid: 3 })],
      ['garbage', () => 'not-a-jwt'],
    ])('refuses %s without consulting the session store', async (_name, makeToken) => {
      const { service, authService } = setup();

      await expect(service.verifyMediaToken(makeToken())).rejects.toThrow(UnauthorizedException);
      expect(authService.validateSessionUser).not.toHaveBeenCalled();
    });
  });

  describe('playback session capability', () => {
    it('re-checks the sign-in the session id was minted under', async () => {
      const { service, authService } = setup();

      await expect(service.verifySessionCapability({ bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password', nonce: 'n' })).resolves.toEqual(
        expect.objectContaining({ id: 7 }),
      );
      expect(authService.validateSessionUser).toHaveBeenCalledWith(7, 1, 'password', 3);
    });

    it('refuses once that sign-in is gone or the account can no longer act', async () => {
      const revoked = setup(null);
      await expect(
        revoked.service.verifySessionCapability({ bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password', nonce: 'n' }),
      ).rejects.toThrow(UnauthorizedException);

      const disabled = setup();
      disabled.authService.findActingUser.mockResolvedValue(null);
      await expect(
        disabled.service.verifySessionCapability({ bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password', nonce: 'n' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
