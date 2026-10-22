import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AbsSessionService } from '../services/abs-session.service';

@Controller('abs/api/session')
export class AbsSessionController {
  constructor(private readonly sessionService: AbsSessionService) {}

  @Post('local')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async syncLocal(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    await this.sessionService.syncLocal(user, body);
    return 'OK';
  }

  @Post('local-all')
  @HttpCode(HttpStatus.OK)
  syncLocalAll(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    return this.sessionService.syncLocalAll(user, body);
  }

  @Get(':id')
  getSession() {
    return this.sessionService.getOpenSession();
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async sync(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    await this.sessionService.sync(user, id, body);
    return 'OK';
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async close(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    await this.sessionService.close(user, id, body);
    return 'OK';
  }
}
