import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

const userRoom = (userId: number) => `user:${userId}`;

/** Holds the ABS socket server so services can push events without depending on the gateway. */
@Injectable()
export class AbsSocketHub {
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  roomFor(userId: number): string {
    return userRoom(userId);
  }

  isListening(userId: number): boolean {
    return (this.server?.sockets.adapter.rooms.get(userRoom(userId))?.size ?? 0) > 0;
  }

  emitToUser(userId: number, event: string, payload: unknown): void {
    this.server?.to(userRoom(userId)).emit(event, payload);
  }
}
