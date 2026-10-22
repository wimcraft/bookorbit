import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { okText } from '../abs-reply';
import { ABS_DEFAULT_PAGE_SIZE, ABS_MAX_PAGE_SIZE, ABS_MAX_SERIES_PAGE_SIZE } from '../abs-compat.constants';
import { includesFlag, parseListQuery } from '../abs-request';
import { AbsAuthService } from '../services/abs-auth.service';
import { AbsBookmarkService } from '../services/abs-bookmark.service';
import { AbsBrowseService, parseAuthorsQuery } from '../services/abs-browse.service';
import { AbsItemService } from '../services/abs-item.service';
import { AbsLibraryService } from '../services/abs-library.service';
import { AbsProgressService } from '../services/abs-progress.service';

type QueryParams = Record<string, unknown>;

@Controller('abs/api')
export class AbsApiController {
  constructor(
    private readonly authService: AbsAuthService,
    private readonly libraryService: AbsLibraryService,
    private readonly itemService: AbsItemService,
    private readonly progressService: AbsProgressService,
    private readonly browseService: AbsBrowseService,
    private readonly bookmarkService: AbsBookmarkService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.authService.me(user);
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@CurrentUser() user: RequestUser) {
    return this.authService.authorize(user);
  }

  @Get('libraries')
  async libraries(@CurrentUser() user: RequestUser, @Query() query: QueryParams) {
    return { libraries: await this.libraryService.listLibraries(user, includesFlag(query, 'stats')) };
  }

  @Get('libraries/:id')
  async library(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    const library = await this.libraryService.getLibrary(user, id);
    if (!includesFlag(query, 'filterdata')) return library;
    const filterdata = this.libraryService.filterData();
    return { filterdata, issues: filterdata.numIssues, numUserPlaylists: 0, library };
  }

  @Get('libraries/:id/items')
  libraryItems(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    return this.libraryService.listItems(user, id, parseListQuery(query, ABS_DEFAULT_PAGE_SIZE, ABS_MAX_PAGE_SIZE));
  }

  @Get('libraries/:id/personalized')
  personalized(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.libraryService.personalized(user, id);
  }

  @Get('libraries/:id/series')
  librarySeries(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    return this.browseService.listSeries(user, id, parseListQuery(query, ABS_DEFAULT_PAGE_SIZE, ABS_MAX_SERIES_PAGE_SIZE));
  }

  @Get('libraries/:id/series/:seriesId')
  librarySeriesOne(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('seriesId') seriesId: string) {
    return this.browseService.getSeries(user, seriesId, id);
  }

  @Get('series/:id')
  series(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.browseService.getSeries(user, id);
  }

  @Get('libraries/:id/authors')
  libraryAuthors(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    return this.browseService.listAuthors(user, id, parseAuthorsQuery(query));
  }

  @Get('authors/:id')
  author(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.browseService.getAuthor(user, id);
  }

  @Get('libraries/:id/search')
  search(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    return this.browseService.search(user, id, query.q, query.limit);
  }

  /** BookOrbit collections and playlists are not mapped yet; an empty page keeps the apps' browse trees intact. */
  @Get(['libraries/:id/collections', 'libraries/:id/playlists'])
  async emptyCollections(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.libraryService.getLibrary(user, id);
    return { results: [], total: 0, limit: 0, page: 0 };
  }

  @Get('items/:id')
  item(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: QueryParams) {
    return this.itemService.getExpanded(user, id, includesFlag(query, 'progress'));
  }

  @Post('items/:id/play')
  @HttpCode(HttpStatus.OK)
  play(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.itemService.play(user, id, body);
  }

  @Get('me/items-in-progress')
  async itemsInProgress(@CurrentUser() user: RequestUser) {
    return { libraryItems: await this.libraryService.itemsInProgress(user) };
  }

  @Get('me/progress/:id')
  progress(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.progressService.getOne(user, id);
  }

  @Patch('me/progress/batch/update')
  async patchProgressBatch(@CurrentUser() user: RequestUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.progressService.patchBatch(user, Array.isArray(body) ? body : []);
    return okText(reply);
  }

  @Patch('me/progress/:id')
  async patchProgress(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.progressService.patchOne(user, id, body);
    return okText(reply);
  }

  @Delete('me/progress/:id')
  async deleteProgress(@CurrentUser() user: RequestUser, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.progressService.remove(user, id);
    return okText(reply);
  }

  @Post('me/item/:id/bookmark')
  @HttpCode(HttpStatus.OK)
  createBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.bookmarkService.create(user, id, body);
  }

  @Patch('me/item/:id/bookmark')
  updateBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.bookmarkService.update(user, id, body);
  }

  @Delete('me/item/:id/bookmark/:time')
  async deleteBookmark(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('time') time: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.bookmarkService.remove(user, id, time);
    return okText(reply);
  }
}
