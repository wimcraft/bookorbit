import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AudiobookModule } from '../audiobook/audiobook.module';
import { AuthModule } from '../auth/auth.module';
import { BookCoverStoreModule } from '../book-cover-store/book-cover-store.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { AbsCompatRepository } from './abs-compat.repository';
import { AbsApiController } from './controllers/abs-api.controller';
import { AbsFallbackController } from './controllers/abs-fallback.controller';
import { AbsMediaController } from './controllers/abs-media.controller';
import { AbsRootController } from './controllers/abs-root.controller';
import { AbsMediaTokenGuard } from './guards/abs-media-token.guard';
import { AbsAuthService } from './services/abs-auth.service';
import { AbsItemService } from './services/abs-item.service';
import { AbsLibraryService } from './services/abs-library.service';
import { AbsMediaService } from './services/abs-media.service';

@Module({
  imports: [JwtModule.register({}), AuthModule, AudiobookModule, BookModule, BookCoverStoreModule, LibraryModule],
  controllers: [AbsRootController, AbsApiController, AbsMediaController, AbsFallbackController],
  providers: [AbsCompatRepository, AbsAuthService, AbsItemService, AbsLibraryService, AbsMediaService, AbsMediaTokenGuard],
})
export class AbsCompatModule {}
