import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { ABS_DEFAULT_PAGE_SIZE, ABS_MAX_PAGE_SIZE } from '../abs-compat.constants';
import { bearerToken, includesFlag, parseListQuery } from '../abs-request';
import { AbsAuthService } from '../services/abs-auth.service';
import { AbsItemService } from '../services/abs-item.service';
import { AbsLibraryService } from '../services/abs-library.service';

type QueryParams = Record<string, unknown>;

@Controller('abs/api')
export class AbsApiController {
  constructor(
    private readonly authService: AbsAuthService,
    private readonly libraryService: AbsLibraryService,
    private readonly itemService: AbsItemService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: RequestUser, @Headers('authorization') authorization: string | undefined) {
    return this.authService.me(user, bearerToken(authorization));
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@CurrentUser() user: RequestUser, @Headers('authorization') authorization: string | undefined) {
    return this.authService.authorize(user, bearerToken(authorization));
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

  @Get('items/:id')
  item(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.itemService.getExpanded(user, id);
  }

  @Post('items/:id/play')
  @HttpCode(HttpStatus.OK)
  play(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.itemService.play(user, id, body);
  }
}
