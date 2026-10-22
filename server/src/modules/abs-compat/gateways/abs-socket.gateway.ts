import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { ABS_SOCKET_AUTH_TIMEOUT_MS, ABS_SOCKET_PATH } from '../abs-compat.constants';
import { encodeUserId } from '../abs-ids';
import { AbsAuthService } from '../services/abs-auth.service';
import { AbsSocketHub } from '../services/abs-socket-hub.service';

interface AbsSocketData {
  userId?: number;
}

/**
 * The ABS apps open a socket at `<server address>/socket.io` and only refresh their in-memory progress
 * from `user_item_progress_updated`, so without it the home screen keeps showing the position from
 * sign-in. As in ABS, the socket connects anonymously and is bound to a user by an `auth` message.
 */
@WebSocketGateway({ path: ABS_SOCKET_PATH, transports: ['websocket'] })
export class AbsSocketGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(AbsSocketGateway.name);

  constructor(
    private readonly authService: AbsAuthService,
    private readonly hub: AbsSocketHub,
  ) {}

  afterInit(server: Server): void {
    this.hub.attach(server);
  }

  handleConnection(client: Socket): void {
    const timer = setTimeout(() => {
      if ((client.data as AbsSocketData).userId === undefined) client.disconnect(true);
    }, ABS_SOCKET_AUTH_TIMEOUT_MS);
    client.once('disconnect', () => clearTimeout(timer));
  }

  @SubscribeMessage('auth')
  async handleAuth(client: Socket, token: unknown): Promise<void> {
    const data = client.data as AbsSocketData;
    try {
      if (typeof token !== 'string' || token.length === 0) throw new Error('Missing token');
      const user = await this.authService.verifyMediaToken(token);
      if (data.userId !== undefined && data.userId !== user.id) await client.leave(this.hub.roomFor(data.userId));
      data.userId = user.id;
      await client.join(this.hub.roomFor(user.id));
      client.emit('init', { userId: encodeUserId(user.id), username: user.username });
    } catch (error) {
      this.logger.debug(
        `[abs.socket_auth] [fail] socketId=${client.id} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - socket auth rejected`,
      );
      client.emit('auth_failed', { message: 'Invalid token' });
    }
  }
}
