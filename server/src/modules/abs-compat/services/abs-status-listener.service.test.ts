import { EventEmitter } from 'events';

import { ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED } from '../../achievement/achievement-events.service';
import { makeUser } from '../abs-test-support';
import { AbsStatusListener } from './abs-status-listener.service';

function setup(listening: boolean) {
  const events = new EventEmitter();
  const authService = { findActingUser: vi.fn().mockResolvedValue(makeUser(7)) };
  const progressService = { publish: vi.fn().mockResolvedValue(undefined) };
  const socketHub = { isListening: vi.fn().mockReturnValue(listening) };
  const listener = new AbsStatusListener(events as never, authService as never, progressService as never, socketHub as never);
  listener.onModuleInit();
  return { events, listener, authService, progressService };
}

describe('AbsStatusListener', () => {
  it('pushes the book progress when a status changes outside the apps', async () => {
    const { listener, progressService } = setup(true);

    await listener.handleStatusChanged({ userId: 7, bookId: 30, newStatus: 'unread', previousStatus: 'read' });

    expect(progressService.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 30);
  });

  it('does nothing when the user has no app connected', async () => {
    const { events, authService, progressService } = setup(false);

    events.emit(ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED, { userId: 7, bookId: 30, newStatus: 'unread', previousStatus: 'read' });
    await Promise.resolve();

    expect(authService.findActingUser).not.toHaveBeenCalled();
    expect(progressService.publish).not.toHaveBeenCalled();
  });
});
