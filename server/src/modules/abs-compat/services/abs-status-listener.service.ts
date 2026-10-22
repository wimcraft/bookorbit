import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import {
  ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED,
  AchievementEventsService,
  type BookStatusChangedPayload,
} from '../../achievement/achievement-events.service';
import { AuthService } from '../../auth/auth.service';
import { AbsProgressService } from './abs-progress.service';
import { AbsSocketHub } from './abs-socket-hub.service';

/** Pushes read status changes made outside the ABS apps (web, KOReader, Kobo) to the user's connected apps. */
@Injectable()
export class AbsStatusListener implements OnModuleInit {
  private readonly logger = new Logger(AbsStatusListener.name);

  constructor(
    private readonly events: AchievementEventsService,
    private readonly authService: AuthService,
    private readonly progressService: AbsProgressService,
    private readonly socketHub: AbsSocketHub,
  ) {}

  onModuleInit(): void {
    this.events.on(ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED, (payload: BookStatusChangedPayload) => {
      void this.handleStatusChanged(payload);
    });
  }

  async handleStatusChanged({ userId, bookId }: BookStatusChangedPayload): Promise<void> {
    if (!this.socketHub.isListening(userId)) return;
    try {
      const user = await this.authService.findActingUser(userId);
      if (user) await this.progressService.publish(user, bookId);
    } catch (error) {
      this.logger.warn(
        `[abs.status_publish] [fail] userId=${userId} bookId=${bookId} errorClass=${error instanceof Error ? error.constructor.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - status change not pushed`,
      );
    }
  }
}
