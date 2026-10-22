import { All, Controller, Logger, NotFoundException, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';

const MAX_LOGGED_PATH_LENGTH = 200;

/** The request path without its query string, which can carry a media token. */
export function pathWithoutQuery(url: string): string {
  const queryStart = url.search(/[?#]/);
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Anything under the ABS mount that no route claims. Logging it is how a client that cannot be
 * read, such as SoundLeaf, reveals the endpoints it needs.
 */
@Controller('abs')
@Public()
export class AbsFallbackController {
  private readonly logger = new Logger(AbsFallbackController.name);

  @All('*')
  unsupported(@Req() req: FastifyRequest): never {
    const userAgent = req.headers['user-agent'];
    this.logger.warn(
      `[abs.unsupported_route] method=${req.method} path="${sanitizeLogValue(pathWithoutQuery(req.url), MAX_LOGGED_PATH_LENGTH)}" userAgent="${sanitizeLogValue(userAgent ?? '', MAX_LOGGED_PATH_LENGTH)}" - route not supported`,
    );
    throw new NotFoundException('Not found');
  }
}
