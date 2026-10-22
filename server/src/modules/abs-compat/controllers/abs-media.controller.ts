import { Controller, Get, Headers, Param, ParseIntPipe, Req, Res, UseGuards } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { sendAudioFile } from '../../../common/utils/audio-stream.utils';
import { imageContentTypeFromPath } from '../../../common/image-content-type';
import { AbsMediaTokenGuard, extractMediaTokens } from '../guards/abs-media-token.guard';
import { AbsMediaService } from '../services/abs-media.service';

@Controller('abs')
@Public()
export class AbsMediaController {
  constructor(
    private readonly mediaService: AbsMediaService,
    private readonly tokenGuard: AbsMediaTokenGuard,
  ) {}

  @Get('api/items/:id/cover')
  @RouteConfig({ compress: false })
  async cover(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const user = extractMediaTokens(req).length > 0 ? await this.tokenGuard.authenticate(req) : null;
    const path = await this.mediaService.resolveCover(id, user);
    const { mtimeMs } = await stat(path);
    const etag = `"${Math.floor(mtimeMs)}"`;
    const cacheControl = user ? 'private, max-age=86400' : 'public, max-age=3600';
    reply.header('Cache-Control', cacheControl);
    reply.header('ETag', etag);
    if (ifNoneMatch === etag) {
      reply.status(304).send();
      return;
    }
    reply.type(imageContentTypeFromPath(path));
    reply.send(createReadStream(path));
  }

  @Get('api/items/:id/file/:ino')
  @UseGuards(AbsMediaTokenGuard)
  @RouteConfig({ compress: false })
  async stream(
    @Param('id') id: string,
    @Param('ino') ino: string,
    @CurrentUser() user: RequestUser,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    sendAudioFile(reply, await this.mediaService.resolveFile(user, id, ino), range, 'inline');
  }

  @Get('api/items/:id/file/:ino/download')
  @UseGuards(AbsMediaTokenGuard)
  @RouteConfig({ compress: false })
  async download(
    @Param('id') id: string,
    @Param('ino') ino: string,
    @CurrentUser() user: RequestUser,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    sendAudioFile(reply, await this.mediaService.resolveFile(user, id, ino), range, 'attachment');
  }

  @Get('public/session/:sessionId/track/:index')
  @RouteConfig({ compress: false })
  async sessionTrack(
    @Param('sessionId') sessionId: string,
    @Param('index', ParseIntPipe) index: number,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    sendAudioFile(reply, await this.mediaService.resolveSessionTrack(sessionId, index), range, 'inline');
  }
}
