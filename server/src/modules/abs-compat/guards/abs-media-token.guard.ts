import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationMethod } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { bearerToken, queryValue } from '../abs-request';
import { AbsAuthService } from '../services/abs-auth.service';

export type AbsMediaRequest = FastifyRequest & { user?: RequestUser };

export function extractMediaTokens(request: Pick<FastifyRequest, 'headers' | 'query'>): string[] {
  const tokens: string[] = [];
  const bearer = bearerToken(request.headers.authorization);
  if (bearer) tokens.push(bearer);
  const queryToken = queryValue((request.query as Record<string, unknown> | undefined)?.token);
  if (queryToken && queryToken !== bearer) tokens.push(queryToken);
  return tokens;
}

/**
 * Guards the read-only media routes that players and downloaders call with a token in the URL.
 * Used on routes marked @Public so the global JWT guard, which enforces expiry, steps aside.
 */
@Injectable()
export class AbsMediaTokenGuard implements CanActivate {
  constructor(private readonly authService: AbsAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AbsMediaRequest>();
    const user = await this.authenticate(request);
    if (user.isDefaultPassword && user.authenticationMethod !== AuthenticationMethod.Oidc) {
      throw new ForbiddenException('Password change required');
    }
    request.user = user;
    return true;
  }

  async authenticate(request: Pick<FastifyRequest, 'headers' | 'query'>): Promise<RequestUser> {
    for (const token of extractMediaTokens(request)) {
      try {
        return await this.authService.verifyMediaToken(token);
      } catch (error) {
        if (!(error instanceof UnauthorizedException)) throw error;
      }
    }
    throw new UnauthorizedException();
  }
}
