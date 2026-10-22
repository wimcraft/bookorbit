import { UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GLOBAL_GUARDS } from '../../../common/guards/global-guards';
import { PermissionService } from '../../../common/services/permission.service';
import { DB } from '../../../db';
import { AuthService } from '../../auth/auth.service';
import { ABS_SOCKET_PATH } from '../abs-compat.constants';
import { makeUser } from '../abs-test-support';
import { AbsAuthService } from '../services/abs-auth.service';
import { AbsSocketHub } from '../services/abs-socket-hub.service';
import { AbsSocketGateway } from './abs-socket.gateway';

/** The ABS socket over a real socket.io connection, on the path and transport the ABS apps use. */
describe('ABS socket gateway over socket.io', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  let hub: AbsSocketHub;
  const absAuth = {
    verifyMediaToken: vi.fn((token: string) => (token === 'good' ? Promise.resolve(makeUser(7)) : Promise.reject(new UnauthorizedException()))),
  };
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1_000 }] })],
      providers: [
        AbsSocketGateway,
        AbsSocketHub,
        { provide: AbsAuthService, useValue: absAuth },
        { provide: JwtService, useValue: new JwtService({ secret: 'abs-socket-test' }) },
        { provide: AuthService, useValue: {} },
        { provide: PermissionService, useValue: {} },
        { provide: DB, useValue: {} },
        ...GLOBAL_GUARDS.map((useClass) => ({ provide: APP_GUARD, useClass })),
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    hub = app.get(AbsSocketHub);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(): Promise<ClientSocket> {
    const client = io(baseUrl, { path: ABS_SOCKET_PATH, transports: ['websocket'], upgrade: false, reconnection: false });
    clients.push(client);
    return new Promise((resolve, reject) => {
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });
  }

  const next = <T>(client: ClientSocket, event: string) => new Promise<T>((resolve) => client.once(event, resolve));

  it('binds the socket to the user on auth and delivers that user its progress events', async () => {
    const client = await connect();
    const init = next<{ userId: string; username: string }>(client, 'init');
    client.emit('auth', 'good');
    await expect(init).resolves.toEqual({ userId: 'usr-7', username: 'listener7' });
    expect(hub.isListening(7)).toBe(true);

    const update = next<unknown>(client, 'user_item_progress_updated');
    hub.emitToUser(8, 'user_item_progress_updated', { id: 'mp-1' });
    hub.emitToUser(7, 'user_item_progress_updated', { id: 'mp-30' });
    await expect(update).resolves.toEqual({ id: 'mp-30' });
  });

  it('answers a bad token with auth_failed and keeps the socket anonymous', async () => {
    const client = await connect();
    const failed = next<{ message: string }>(client, 'auth_failed');
    client.emit('auth', 'forged');
    await expect(failed).resolves.toEqual({ message: 'Invalid token' });
    expect(hub.isListening(7)).toBe(false);
  });
});
