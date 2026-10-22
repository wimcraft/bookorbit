import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AchievementModule } from '../achievement/achievement.module';
import { AudiobookModule } from '../audiobook/audiobook.module';
import { AuthModule } from '../auth/auth.module';
import { AuthorsModule } from '../authors/authors.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { ReadingSessionModule } from '../reading-session/reading-session.module';
import { AbsCompatRepository } from './abs-compat.repository';
import { AbsApiController } from './controllers/abs-api.controller';
import { AbsFallbackController } from './controllers/abs-fallback.controller';
import { AbsMediaController } from './controllers/abs-media.controller';
import { AbsRootController } from './controllers/abs-root.controller';
import { AbsSessionController } from './controllers/abs-session.controller';
import { AbsSocketGateway } from './gateways/abs-socket.gateway';
import { AbsMediaTokenGuard } from './guards/abs-media-token.guard';
import { AbsAuthService } from './services/abs-auth.service';
import { AbsBookmarkService } from './services/abs-bookmark.service';
import { AbsBrowseService } from './services/abs-browse.service';
import { AbsItemService } from './services/abs-item.service';
import { AbsLibraryService } from './services/abs-library.service';
import { AbsListeningStatsService } from './services/abs-listening-stats.service';
import { AbsMediaService } from './services/abs-media.service';
import { AbsProgressService } from './services/abs-progress.service';
import { AbsSessionService } from './services/abs-session.service';
import { AbsSocketHub } from './services/abs-socket-hub.service';
import { AbsStatusListener } from './services/abs-status-listener.service';

@Module({
  imports: [
    JwtModule.register({}),
    AchievementModule,
    AuthModule,
    AuthorsModule,
    AudiobookModule,
    BookModule,
    BookCoverStoreModule,
    LibraryModule,
    ReadingSessionModule,
  ],
  controllers: [AbsRootController, AbsApiController, AbsSessionController, AbsMediaController, AbsFallbackController],
  providers: [
    AbsCompatRepository,
    AbsAuthService,
    AbsBookmarkService,
    AbsBrowseService,
    AbsItemService,
    AbsLibraryService,
    AbsListeningStatsService,
    AbsMediaService,
    AbsProgressService,
    AbsSessionService,
    AbsSocketHub,
    AbsSocketGateway,
    AbsStatusListener,
    AbsMediaTokenGuard,
  ],
})
export class AbsCompatModule {}
