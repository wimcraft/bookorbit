import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationMethod, NativeCredentials } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { authConfig } from '../../../config/config';
import type { LoginDto } from '../../auth/dto/login.dto';
import { AuthService } from '../../auth/auth.service';
import type { AbsLoginPayload, AbsUser } from '../abs-compat.types';
import { type PlaybackSessionIdParts } from '../abs-ids';
import { asRecord, deriveDeviceLabel, readString } from '../abs-request';
import { toAbsLoginPayload, toAbsUser } from '../serializers/user.serializer';
import { AbsBookmarkService } from './abs-bookmark.service';
import { AbsLibraryService } from './abs-library.service';
import { AbsProgressService } from './abs-progress.service';

const REFRESH_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_USERNAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 1024;

interface AccessTokenPayload {
  sub?: unknown;
  ver?: unknown;
  sid?: unknown;
  amr?: unknown;
}

function errorFields(error: unknown): string {
  const errorClass = error instanceof Error ? error.constructor.name : 'Error';
  const message = sanitizeLogValue(error instanceof Error ? error.message : error);
  return `errorClass=${errorClass} error="${message}"`;
}

@Injectable()
export class AbsAuthService {
  private readonly logger = new Logger(AbsAuthService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly jwt: JwtService,
    private readonly progressService: AbsProgressService,
    private readonly libraryService: AbsLibraryService,
    private readonly bookmarkService: AbsBookmarkService,
    @Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Password sign-in through the same credential check, lockout, audit and session issuance as the web
   * login. A user with no usable password (OIDC-only accounts hold a random one) fails that check.
   */
  async login(body: unknown, req: FastifyRequest, reply: FastifyReply): Promise<AbsLoginPayload> {
    const started = Date.now();
    const source = asRecord(body);
    const username = readString(source, 'username');
    const password = readString(source, 'password');
    const deviceLabel = deriveDeviceLabel(req.headers['user-agent']);
    this.logger.log(`[abs.login] [start] ip=${sanitizeLogValue(req.ip)} deviceLabel="${sanitizeLogValue(deviceLabel)}" - login started`);
    try {
      if (!username || !password || username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new UnauthorizedException('Invalid credentials');
      }
      const dto = { username, password, clientKind: 'native', deviceLabel } as LoginDto;
      const result = (await this.authService.login(dto, reply, req.ip)) as NativeCredentials & { user: { id: number } };
      const user = await this.requireActingUser(result.user.id);
      const returnTokens = req.headers['x-return-tokens'] === 'true';
      const payload = await this.buildPayload(user, {
        token: result.accessToken,
        accessToken: result.accessToken,
        refreshToken: returnTokens ? result.refreshToken : null,
      });
      this.logger.log(`[abs.login] [end] userId=${user.id} durationMs=${Date.now() - started} returnTokens=${returnTokens} - login completed`);
      return payload;
    } catch (error) {
      this.logger.warn(`[abs.login] [fail] durationMs=${Date.now() - started} ${errorFields(error)} - login failed`);
      throw error;
    }
  }

  async refresh(req: FastifyRequest, reply: FastifyReply): Promise<AbsLoginPayload> {
    const started = Date.now();
    const header = req.headers['x-refresh-token'];
    const refreshToken = typeof header === 'string' ? header.trim() : '';
    this.logger.log(`[abs.refresh] [start] ip=${sanitizeLogValue(req.ip)} - refresh started`);
    try {
      if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw new UnauthorizedException();
      const credentials = await this.authService.refresh(req, reply, { refreshToken });
      if (!('refreshToken' in credentials)) throw new UnauthorizedException();
      const decoded = this.jwt.decode<AccessTokenPayload>((credentials as NativeCredentials).accessToken);
      const user = await this.requireActingUser(typeof decoded?.sub === 'number' ? decoded.sub : -1);
      const payload = await this.buildPayload(user, {
        token: credentials.accessToken,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
      });
      this.logger.log(
        `[abs.refresh] [end] userId=${user.id} sessionId=${credentials.sessionId} durationMs=${Date.now() - started} - refresh completed`,
      );
      return payload;
    } catch (error) {
      this.logger.warn(`[abs.refresh] [fail] durationMs=${Date.now() - started} ${errorFields(error)} - refresh failed`);
      throw error;
    }
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers['x-refresh-token'];
    const refreshToken = typeof header === 'string' ? header.trim() : '';
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) return;
    try {
      await this.authService.logout(req, reply, { refreshToken });
    } catch (error) {
      this.logger.warn(`[abs.logout] [fail] ${errorFields(error)} - logout failed`);
    }
  }

  async authorize(user: RequestUser, bearerToken: string | null): Promise<AbsLoginPayload> {
    return this.buildPayload(user, { token: bearerToken ?? '' });
  }

  async me(user: RequestUser, bearerToken: string | null): Promise<AbsUser> {
    return (await this.buildUser(user, bearerToken ?? '')).absUser;
  }

  /**
   * Validates a bearer or `?token=` credential for the read-only media routes. The JWT lifetime is
   * ignored on purpose: players keep issuing range requests with the URL they were first given, so
   * the boundary is the sign-in session and the user's token version, both checked on every call.
   */
  async verifyMediaToken(token: string): Promise<RequestUser> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        ignoreExpiration: true,
      });
    } catch {
      throw new UnauthorizedException();
    }
    if (typeof payload.sub !== 'number' || typeof payload.ver !== 'number' || typeof payload.sid !== 'number') throw new UnauthorizedException();
    const amr = (typeof payload.amr === 'string' ? payload.amr : 'legacy') as AuthenticationMethod;
    return this.authService.validateSessionUser(payload.sub, payload.ver, amr, payload.sid);
  }

  /** The sign-in a playback session id was minted under must still be live, exactly as for a media token. */
  async verifySessionCapability(parts: PlaybackSessionIdParts): Promise<RequestUser> {
    const acting = await this.authService.findActingUser(parts.userId);
    if (!acting) throw new UnauthorizedException();
    return this.authService.validateSessionUser(parts.userId, acting.tokenVersion, parts.authMethod as AuthenticationMethod, parts.authSessionId);
  }

  private async requireActingUser(userId: number): Promise<RequestUser> {
    const user = await this.authService.findActingUser(userId);
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private async buildPayload(
    user: RequestUser,
    tokens: { token: string; accessToken?: string; refreshToken?: string | null },
  ): Promise<AbsLoginPayload> {
    const { absUser, libraryIds } = await this.buildUser(user, tokens.token);
    if (tokens.accessToken !== undefined) absUser.accessToken = tokens.accessToken;
    if (tokens.refreshToken !== undefined) absUser.refreshToken = tokens.refreshToken;
    return toAbsLoginPayload(absUser, libraryIds[0] ?? null);
  }

  private async buildUser(user: RequestUser, token: string): Promise<{ absUser: AbsUser; libraryIds: number[] }> {
    const [progress, libraryIds, bookmarks] = await Promise.all([
      this.progressService.listForUser(user),
      this.libraryService.accessibleBookLibraryIds(user),
      this.bookmarkService.listForUser(user),
    ]);
    return { absUser: toAbsUser(user, progress, libraryIds, token, Date.now(), bookmarks), libraryIds };
  }
}
