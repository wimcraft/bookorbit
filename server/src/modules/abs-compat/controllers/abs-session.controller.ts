import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { okText } from '../abs-reply';
import { AbsSessionService } from '../services/abs-session.service';

@Controller('abs/api/session')
export class AbsSessionController {
  constructor(private readonly sessionService: AbsSessionService) {}

  @Post('local')
  @HttpCode(HttpStatus.OK)
  async syncLocal(
    @CurrentUser() user: RequestUser,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessionService.syncLocal(user, body, userAgent);
    return okText(reply);
  }

  @Post('local-all')
  @HttpCode(HttpStatus.OK)
  syncLocalAll(@CurrentUser() user: RequestUser, @Body() body: unknown, @Headers('user-agent') userAgent: string | undefined) {
    return this.sessionService.syncLocalAll(user, body, userAgent);
  }

  @Get(':id')
  getSession() {
    return this.sessionService.getOpenSession();
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  async sync(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessionService.sync(user, id, body, userAgent);
    return okText(reply);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessionService.close(user, id, body, userAgent);
    return okText(reply);
  }
}
