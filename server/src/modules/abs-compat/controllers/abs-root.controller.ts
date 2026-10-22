import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { ABS_COMPAT_LANGUAGE, ABS_COMPAT_SERVER_VERSION } from '../abs-compat.constants';
import { AbsAuthService } from '../services/abs-auth.service';

const ONE_MINUTE_MS = 60_000;

@Controller('abs')
@Public()
export class AbsRootController {
  constructor(private readonly authService: AbsAuthService) {}

  @Get('status')
  status() {
    return {
      app: 'audiobookshelf',
      serverVersion: ABS_COMPAT_SERVER_VERSION,
      isInit: true,
      language: ABS_COMPAT_LANGUAGE,
      authMethods: ['local'],
      authFormData: {},
    };
  }

  @Get('ping')
  ping() {
    return { success: true };
  }

  @Throttle({ default: { limit: 5, ttl: ONE_MINUTE_MS } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.authService.login(body, req, reply);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.authService.refresh(req, reply);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.authService.logout(req, reply);
    return { redirect_url: null };
  }
}
