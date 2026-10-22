import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { sendAudioFile } from '../../common/utils/audio-stream.utils';
import { AudiobookService } from './audiobook.service';
import { CreateAudiobookBookmarkDto } from './dto/create-audiobook-bookmark.dto';
import { PutAudiobookPlaybackStateDto } from './dto/put-audiobook-playback-state.dto';
import { UpdateAudiobookBookmarkDto } from './dto/update-audiobook-bookmark.dto';

@Controller('audiobooks')
export class AudiobookController {
  constructor(private readonly service: AudiobookService) {}

  @Get(':bookId/manifest')
  getManifest(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.getManifest(bookId, user);
  }

  @Get(':bookId/assets/:assetId/content')
  async serveAsset(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('assetId') assetId: string,
    @CurrentUser() user: RequestUser,
    @Headers('range') rangeHeader: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const asset = await this.service.getAsset(bookId, assetId, user);
    sendAudioFile(reply, asset, rangeHeader);
  }

  @Get(':bookId/playback-state')
  getPlaybackState(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.getPlaybackState(bookId, user);
  }

  @Put(':bookId/playback-state')
  putPlaybackState(@Param('bookId', ParseIntPipe) bookId: number, @Body() dto: PutAudiobookPlaybackStateDto, @CurrentUser() user: RequestUser) {
    return this.service.putPlaybackState(bookId, dto, user);
  }

  @Delete(':bookId/playback-state')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePlaybackState(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.deletePlaybackState(bookId, user);
  }

  @Get(':bookId/bookmarks')
  listBookmarks(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.service.listBookmarks(bookId, user);
  }

  @Post(':bookId/bookmarks')
  createBookmark(@Param('bookId', ParseIntPipe) bookId: number, @Body() dto: CreateAudiobookBookmarkDto, @CurrentUser() user: RequestUser) {
    return this.service.createBookmark(bookId, dto, user);
  }

  @Patch(':bookId/bookmarks/:bookmarkId')
  updateBookmark(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
    @Body() dto: UpdateAudiobookBookmarkDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updateBookmark(bookId, bookmarkId, dto, user);
  }

  @Delete(':bookId/bookmarks/:bookmarkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteBookmark(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.deleteBookmark(bookId, bookmarkId, user);
  }
}
