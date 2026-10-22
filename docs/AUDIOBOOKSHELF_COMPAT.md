# Audiobookshelf-Compatible API (fork-only)

Status: phases 1 to 3 (connect, stream, progress and offline sync, series, authors, search, bookmarks, listening stats) implemented and verified against a real database; see Implementation notes. Not yet tried on the phones. Personal fork feature, not intended for upstream.

## Goal

Let existing Audiobookshelf (ABS) mobile clients use BookOrbit as their server, so a household can drop the separate ABS service:

- **Audiobookshelf app** (Android, v0.14.x) including Android Auto.
- **SoundLeaf** (iOS, closed source) including CarPlay.

The must-have use case is **offline listening in the car**: download a book on the phone, listen with no connection, and have progress merge correctly when the phone is back online, across two users and several devices.

## Non-goals (v1)

- Podcasts, playlists, collections, RSS feeds, e-books through ABS clients.
- Admin endpoints (library/user management, scans, uploads, metadata edits).
- Server-side transcoding and HLS. Only direct play of the original files.
- OpenID login through ABS clients. Password users only (see Auth).
- Socket.io events beyond the progress push in Live updates (no scans, user lists or podcast events).
- Upstream acceptance. Code follows CLAUDE.md conventions anyway, so rebasing stays cheap.

## Reference spec

There is no complete ABS API spec. The reference is the ABS source, pinned:

- Server: `advplyr/audiobookshelf` tag `v2.37.1`
  - routes: `server/routers/ApiRouter.js`, `server/Server.js` (`/status`, `/ping`), `server/Auth.js` (`/login`, `/auth/refresh`, `/logout`)
  - serializers: `server/models/LibraryItem.js` (`toOldJSONMinified`, `toOldJSONExpanded`), `server/models/Book.js`, `server/models/Library.js`, `server/models/User.js` (`toOldJSONForBrowser`), `server/models/MediaProgress.js` (`getOldMediaProgress`), `server/objects/PlaybackSession.js`, `server/objects/files/AudioTrack.js`, `server/objects/files/AudioFile.js`
  - sync semantics: `server/managers/PlaybackSessionManager.js` (`syncLocalSession`, `startSession`), `server/controllers/MeController.js`, `server/controllers/SessionController.js`
- Client: `advplyr/audiobookshelf-app` `master` (0.14.x)
  - login flow: `components/connection/ServerConnectForm.vue`
  - native API usage: `android/app/src/main/java/com/audiobookshelf/app/server/ApiHandler.kt`, `ios/App/Shared/util/ApiClient.swift`
  - token refresh: `plugins/nativeHttp.js`, `ApiHandler.kt` `refreshAuthTokens`

Response field names, nesting and types must match those serializers. Missing fields usually crash the client or render empty screens with no server error, so when unsure, include the field with a neutral value (`null`, `[]`, `0`, `false`) rather than omitting it.

SoundLeaf cannot be read. Its coverage is verified empirically through the unknown-route log (see Observability).

## Module layout

New feature module `server/src/modules/abs-compat/`, self-contained:

```
abs-compat/
  abs-compat.module.ts
  controllers/
    abs-root.controller.ts        # /status, /ping, /login, /logout, /auth/refresh
    abs-api.controller.ts         # /api/me, /api/authorize, /api/libraries/*, /api/items/*
    abs-session.controller.ts     # /api/session/*
  services/
    abs-auth.service.ts
    abs-library.service.ts
    abs-item.service.ts
    abs-progress.service.ts
    abs-session.service.ts
  serializers/                    # pure functions BookOrbit -> ABS JSON, unit tested
  guards/abs-media-token.guard.ts
  abs-ids.ts                      # id encode/decode
  abs-compat.types.ts             # ABS wire types (local to this module, not packages/types)
  dto/
```

Wire types stay in the module, not `packages/types/`: the client never consumes them.

### Upstream touch points (keep this list minimal for rebases)

1. `server/src/app.module.ts`: import `AbsCompatModule`.
2. `server/src/modules/audiobook/audiobook.module.ts`: add `exports: [AudiobookService]`.
3. `server/src/modules/audiobook/audiobook.service.ts`: add `applyExternalPosition` (see Progress).
4. `server/src/modules/auth/`: export what ABS login/refresh needs (see Auth). Prefer calling existing `AuthService` methods over adding new ones.

**No database schema changes and no migrations.** Upstream adds Drizzle migrations often; a fork migration would conflict on nearly every rebase. Everything below is designed to fit existing tables.

## Mounting

All routes live under the existing global prefix: `/api/v1/abs`. Users enter the server address `https://<host>/api/v1/abs` in the app. No change to `main.ts`.

| ABS path                                                 | BookOrbit path            |
| -------------------------------------------------------- | ------------------------- |
| `/status`, `/ping`, `/login`, `/logout`, `/auth/refresh` | `/api/v1/abs/status`, ... |
| `/api/...`                                               | `/api/v1/abs/api/...`     |

The ABS app builds every URL as `${address}${path}` after stripping a trailing slash, so a subpath works. SoundLeaf subpath support is assumed (ABS itself supports a base path) and must be verified on the device. Fallback if it does not: add `abs` routes to the `setGlobalPrefix` exclude list and serve at the host root on a separate hostname.

ABS clients send JSON and expect ABS error behavior (status code plus plain text body). The global exception filter's JSON body is acceptable; clients only branch on status codes.

## Auth

Reuse BookOrbit's existing **native sessions**, which already provide rotating refresh tokens, sliding expiry, revocation via `tokenVersion`, and appear in the user's session list. No new token storage.

### `GET /status` (public)

```json
{
  "app": "audiobookshelf",
  "serverVersion": "2.26.0",
  "isInit": true,
  "language": "en-us",
  "authMethods": ["local"],
  "authFormData": {}
}
```

`serverVersion` is a constant `ABS_COMPAT_SERVER_VERSION = "2.26.0"`: the lowest version that makes the app use access + refresh tokens. Raise it only when a client needs a newer feature gate.

### `GET /ping` (public)

`{ "success": true }`

### `POST /login` (public, throttled like BookOrbit login)

Body `{ username, password }`. Header `x-return-tokens: true` means the client wants the refresh token in the body (always the case for the mobile apps).

- Delegate to the same credential check, lockout, audit and session issuance as `AuthService.login`, with `clientKind: 'native'` and `deviceLabel` derived from `User-Agent` (for example `Audiobookshelf app (Android)`, `SoundLeaf (iOS)`), so the session is recognizable and revocable in BookOrbit.
- Refuse users without a password (OIDC-only) with 401.
- Respond with the ABS login payload (see `Auth.getUserLoginResponsePayload` in ABS): `{ user, userDefaultLibraryId, serverSettings, ereaderDevices: [], Source: "docker" }` where `user` is the ABS user object (below) plus `accessToken`, `refreshToken` (only when `x-return-tokens: true`) and `token` (set equal to `accessToken` for older clients).

### `POST /auth/refresh` (public)

Refresh token in header `x-refresh-token`. Delegate to the native refresh path of `AuthService.refresh`. Respond like `/login` with the new `accessToken` and `refreshToken`. 401 when the refresh token is invalid; the apps then show the login screen.

### `POST /logout`

Revoke the native session for the refresh token in `x-refresh-token` if present. Always 200.

### Authenticated requests

The apps send `Authorization: Bearer <accessToken>`. The global `JwtAuthGuard` already reads that header, so ABS API controllers use the normal guard and `@CurrentUser()`.

### Media URLs (`?token=`)

Players and downloaders put the token in the query string: `/api/items/:id/cover?token=...`, `/api/items/:id/file/:ino?token=...`, `/api/items/:id/file/:ino/download?token=...`.

These routes are `@Public()` and use `AbsMediaTokenGuard`:

1. Accept the token from `Authorization: Bearer` or the `token` query parameter.
2. Verify the JWT signature with the BookOrbit secret, **ignoring `exp`**.
3. Require the session (`sid`) to still be active and `ver` to match the user's `tokenVersion` (`AuthService.validateSessionUser`).
4. Attach the `RequestUser`; the service still checks book access.

Why ignore `exp`: a single-file M4B can be 20+ hours and ExoPlayer/AVPlayer keep issuing range requests with the URL they were given. A 15-minute access token would break seeking and downloads mid-book. Revoking the session or changing the password still cuts access immediately, so the security boundary is the session, not the JWT lifetime. This applies only to these three read-only media routes.

### Deployment note

BookOrbit's refresh window is `JWT_REFRESH_EXPIRES_IN` (default `7d`, sliding). A phone that stays offline longer than that must log in again. Recommend `JWT_REFRESH_EXPIRES_IN=30d` (ABS default) in the household deployment.

## IDs

ABS uses string IDs; BookOrbit uses integers and UUID `publicId`s. Encode, never store:

| ABS id                | Encoding                         | Example       |
| --------------------- | -------------------------------- | ------------- |
| library `id`          | `lib-<libraryId>`                | `lib-3`       |
| library item `id`     | `li-<bookId>`                    | `li-1287`     |
| media (book) `id`     | `book-<bookId>`                  | `book-1287`   |
| audio file `ino`      | BookOrbit file `publicId` (UUID) | `6f1c...`     |
| media progress `id`   | `mp-<bookId>`                    | `mp-1287`     |
| playback session `id` | `ps-<bookId>-<uuidv4>`           | `ps-1287-...` |
| series `id`           | `ser-<seriesId>`                 |               |
| author `id`           | `aut-<authorId>`                 |               |
| user `id`             | `usr-<userId>`                   |               |

`abs-ids.ts` owns encode/decode with strict parsing; malformed ids throw `NotFoundException`. Never trust an id for authorization: every decoded `bookId` goes through `BookService.verifyBookAccess` (or the audiobook service, which does it).

Session ids carry the `bookId` so `/session/:id/sync` needs no server-side session table. Local sessions arrive with the client's own id (`play_local_...`); for those use `libraryItemId` from the body.

## Libraries and items

### Which libraries

`GET /api/libraries` returns BookOrbit libraries the user can access (`LibraryService.findAll` already scopes) with `type === 'books'`, as ABS libraries with `mediaType: "book"`. Podcast libraries are skipped in v1.

Shape: `{ libraries: [LibraryJSON] }`. `GET /api/libraries/:id` returns `{ library, filterdata, issues: 0, numUserPlaylists: 0 }`; `filterdata` may be empty arrays.

### Which items

Only books with at least one audio file are exposed. Use the existing query engine: `BookService.queryForLibrary(user, libraryId, { filter: <format includesAny audio formats>, sort, pagination })`. The audio format list comes from `@bookorbit/types` (`isAudioFormat` source list).

`GET /api/libraries/:id/items` supports ABS query params `limit`, `page` (0-based), `sort` (`media.metadata.title`, `media.metadata.authorName`, `addedAt`, `media.duration`), `desc`, `filter` (v1: ignore unknown filters rather than 400), `minified=1`. Response: `{ results: [LibraryItemMinified], total, limit, page, sortBy, sortDesc, filterBy, mediaType: "book", minified, collapseseries: false, include: "" }`.

Scale rules (CLAUDE.md): never load a whole library. Default `limit` 50, max 200. Per page, fetch extra fields (durations, file counts, sizes, progress) with **one batched query per page**, not per item.

### Item JSON

- **Minified** (`toOldJSONMinified`): list views. Needs `media.metadata.title`, `authorName`, `narratorName`, `seriesName`, `media.duration`, `media.numTracks`, `media.numAudioFiles`, `media.coverPath` (non-null when the book has a cover), `addedAt`, `updatedAt`, `size`, `mediaType: "book"`, `isMissing: false`, `isInvalid: false`.
- **Expanded** (`GET /api/items/:id?expanded=1`, `toOldJSONExpanded`): adds `media.audioFiles`, `media.chapters`, `media.tracks`, `libraryFiles`, and `userMediaProgress` when `include=progress`. Build from `AudiobookService.getManifest` (already ordered tracks, durations, chapters with absolute start/end).

Mapping from the manifest:

| ABS                                                       | BookOrbit                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `audioFiles[i].ino`                                       | file `publicId`                                                                          |
| `audioFiles[i].index`                                     | `sequence + 1`                                                                           |
| `audioFiles[i].duration` (s)                              | `durationMs / 1000`                                                                      |
| `audioFiles[i].metadata.{filename,ext,path,relPath,size}` | file name, extension, relative path, `sizeBytes`                                         |
| `audioFiles[i].mimeType`                                  | same table as `AUDIO_MIME_TYPES` in `audiobook.controller.ts`                            |
| `tracks[i].startOffset` (s)                               | sum of previous asset durations                                                          |
| `tracks[i].contentUrl`                                    | `/api/items/li-<bookId>/file/<publicId>` (relative; the app prefixes the server address) |
| `chapters[i].{id,start,end,title}` (s)                    | `sequence`, `startMs/1000`, `endMs/1000`, `title`                                        |
| `media.duration`                                          | `totalDurationMs / 1000`                                                                 |

Do not leak absolute filesystem paths: `path` and `relPath` are the path relative to the library root.

### Other browse endpoints

- `GET /api/libraries/:id/personalized`: shelves for Android Auto / CarPlay and the home screen. v1 shelves: `continue-listening` (user's in-progress audiobooks in this library, by `capturedAt` desc, max 20), `recently-added` (max 20), `listen-again` (finished, max 20). Shape per shelf: `{ id, label, labelStringKey, type: "book", entities: [LibraryItemMinified], total }`.
- `GET /api/me/items-in-progress`: `{ libraryItems: [LibraryItemMinified + progressLastUpdate] }`, max 25, used by Android Auto.
- `GET /api/libraries/:id/series`, `/authors`, `/search?q=`: map to BookOrbit series, authors and `q` search, paged, audiobooks only. See Browse (phase 3) below.
- `GET /api/items/:id/cover`: stream the BookOrbit cover (`BookService.getCoverPath`), 404 when none. Honor `width`/`format` by ignoring them in v1.

### Audio file streaming and download

- `GET /api/items/:id/file/:ino` (stream) and `GET /api/items/:id/file/:ino/download` (download for offline). Both resolve through `AudiobookService.getAsset` (access check included) and reuse the Range-aware streaming logic of `AudiobookController.serveAsset`. Extract that logic into a small shared helper rather than copying it. Download adds `Content-Disposition: attachment`.

## Progress

### Source of truth

BookOrbit's audiobook playback state (per user, per book) is the only store. ABS media progress is a view of it:

| ABS `mediaProgress`              | BookOrbit                                                  |
| -------------------------------- | ---------------------------------------------------------- |
| `id`                             | `mp-<bookId>`                                              |
| `libraryItemId`                  | `li-<bookId>`                                              |
| `mediaItemId`                    | `book-<bookId>`                                            |
| `mediaItemType`                  | `"book"`                                                   |
| `episodeId`                      | `null`                                                     |
| `duration` (s)                   | manifest `totalDurationMs / 1000`                          |
| `currentTime` (s)                | absolute position: previous asset durations + `positionMs` |
| `progress` (0..1)                | `percentage / 100`                                         |
| `isFinished`                     | read status is finished, or `percentage >= 100`            |
| `lastUpdate` (ms epoch)          | playback state `capturedAt`                                |
| `startedAt`, `finishedAt`        | read status dates when known, else `capturedAt` / `null`   |
| `hideFromContinueListening`      | `false`                                                    |
| `ebookLocation`, `ebookProgress` | `null`, `0`                                                |

`lastUpdate` must be the time the listening happened (`capturedAt`), not the time the server wrote it. The app compares it with its local progress to decide which side wins.

`user.mediaProgress` (in `/api/me`, `/api/authorize`, `/login`) lists the user's audiobook playback states. It is bounded by the number of audiobooks the user has started, not by library size; still cap it (most recent 1000 by `capturedAt`) and fetch in one query.

### Write path: `AudiobookService.applyExternalPosition`

New method in the audiobook module (owner of playback state):

```ts
applyExternalPosition(
  bookId: number,
  user: RequestUser,
  input: { absolutePositionMs: number; capturedAt: Date; finished?: boolean },
): Promise<{ applied: boolean; state: AudiobookPlaybackState | null }>
```

1. Load the manifest context (access check included).
2. Clamp `absolutePositionMs` to `[0, totalDurationMs]` and convert it to `(assetId, positionMs)` by walking asset durations.
3. Read the current row. **If `row.capturedAt > input.capturedAt`, do not write**; return `applied: false` with the current state. Equal timestamps write (idempotent retries).
4. Otherwise write through the same path as `putPlaybackState` (create or revision-guarded update, read status auto-update, ebook progress sync), using a fresh `operationId` and the current `baseRevision`. On a revision conflict, re-read and repeat from step 3 once.
5. `finished: true` sets the position to the end and percentage to 100.

This keeps every downstream effect (read status, cross-format sync, Kobo) identical to the web player.

### Merge rule: last listened wins

The single rule, matching ABS `syncLocalSession`: **an update applies only if it describes listening that happened at or after the stored `capturedAt`.** Timestamps per entry point:

| Entry point                                                   | `capturedAt` used                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/session/:id/sync` (live streaming)                 | server `now`                                                      |
| `POST /api/session/:id/close` with body                       | server `now`                                                      |
| `POST /api/session/local`, `/api/session/local-all` (offline) | session `updatedAt` from the body (ms epoch), clamped to `<= now` |
| `PATCH /api/me/progress/:libraryItemId`                       | body `lastUpdate` if present (clamped to `<= now`), else `now`    |
| `PATCH /api/me/progress/batch/update`                         | per entry, same as above                                          |

Consequences, which are the behaviors to test:

- Phone A listens offline to minute 300 in the car at 18:00. Phone B (same user) listened online to minute 200 at 20:00. Phone A reconnects at 21:00: the server keeps minute 200 (B listened later), and phone A's next `/api/me` pull moves it to minute 200.
- Phone A listens offline to minute 300 at 18:00, nothing else happens, phone A reconnects: server moves to minute 300.
- The same offline session uploaded twice applies once (equal timestamp, same position: no-op).
- A client clock far in the future cannot pin progress forever: timestamps are clamped to `now`.
- Two users never interact: every read and write is scoped by `user.id`.

### Mark finished / reset

- `PATCH /api/me/progress/:id` with `isFinished: true`: `applyExternalPosition(..., finished: true)`.
- `isFinished: false`: move to `currentTime` (default 0) with a fresh timestamp. Coming down from 100% is the reread evidence BookOrbit already uses, so a book marked read moves to rereading and shows as not finished in the apps.
- `DELETE /api/me/progress/:id`: delete the playback state (`AudiobookService.deletePlaybackState`). Read status is left as is.

## Playback sessions

No session table. Sessions exist only in their id.

- `POST /api/items/:id/play` with `{ deviceInfo, mediaPlayer, supportedMimeTypes, forceDirectPlay }`: verify access, build the ABS `PlaybackSession` JSON: `id: ps-<bookId>-<uuid>`, `playMethod: 0` (direct play), `audioTracks` (same as item `tracks`), `chapters`, `duration`, `currentTime` from the stored position, `mediaMetadata`, `displayTitle`, `displayAuthor`, `libraryItem` (expanded), `startedAt`/`updatedAt` = now. Always direct play; never transcode.
- `POST /api/session/:id/sync` `{ currentTime, timeListened, duration }`: decode `bookId`, `applyExternalPosition` with `now`. 200 with empty body.
- `POST /api/session/:id/close` (optional same body): like sync if a body is present; 200.
- `GET /api/session/:id`: 404 (no stored sessions). Clients treat it as closed.
- `POST /api/session/local` (single) and `POST /api/session/local-all` `{ sessions: [...] }`: for each session, resolve `bookId` from `libraryItemId`, apply with the session's `updatedAt`. `local-all` returns `{ results: [{ id, success, progressSynced, error? }] }` and never fails the whole batch for one bad entry (unknown item: `success: false, error: "Media item not found"`). Cap `sessions` at 500 per request.

### Listening time (stats)

Listening is recorded as BookOrbit listen sessions (`ReadingSessionService.save`, `sessionType: 'listen'`), so it shows in reading statistics. `save` keys a session by id and only ever raises a stored duration, which makes every write safe to repeat.

- Offline sessions carry a cumulative `timeListening`, so each one is saved under its own id with its own `startedAt`/`updatedAt` span. Every applied session counts, not only the newest per book, because each one is a separate stretch of listening.
- Streaming syncs carry only the seconds since the previous sync (`timeListened`), so `AbsListeningStatsService` keeps a running total per playback session in memory (at most 2000 sessions, dropped after 12 hours idle) and saves that total on every sync. After a restart a session's total starts from zero again and the stored row is not lowered: a session cut by a restart can be undercounted but never counted twice. One tick above 600 seconds is capped.
- ABS session ids can exceed the 64 characters BookOrbit keeps, so rows use `abs-<sha256 prefix>` of the ABS id.
- The source is `android` or `ios` from the user agent (`web` otherwise).
- Stats are best effort: a failure logs `[abs.listening_stats] [fail]` and never fails the progress write that carried it.

## Browse (phase 3)

All lists are scoped by the same where clause as the item listing (`AbsLibraryService.bookScope`): library access, the user's content filters, the audio-only rule, and no books still processing. A series or author therefore never appears only because of books the user cannot see.

- `GET /api/libraries/:id/series`: series with at least one visible audiobook, by name, paged. Each series embeds its visible books (minified, in series order, at most 25), because Android Auto drops a series whose `books` have no tracks. The app asks for `limit=10000`; the page is capped at 500. `GET /api/series/:id` and `GET /api/libraries/:id/series/:seriesId` return one series the same way.
- `GET /api/libraries/:id/items?filter=<group>.<base64>`: `series` and `authors` match by id through `EXISTS` on the membership tables (BookOrbit's `author` rule is a substring match, so `John` would also match `Johnson`). A series filter sorts by series index, then title. `genres` and `tags` go through the query engine by name. Other groups (`progress`, `narrators`, ...) are ignored, and an id this server never issued gives an empty page, as ABS does. Android encodes with `Base64.DEFAULT` (line breaks inside) and an unescaped `+` arrives as a space; both are undone.
- `GET /api/libraries/:id/authors`: authors of visible audiobooks with their book counts. Without `limit` and `page` the answer is `{ authors: [...] }` capped at 1000, as the app expects; with them it is a paged `results` payload. `sort=numBooks` is supported. `GET /api/authors/:id` returns one author with its `libraryItems`.
- `GET /api/authors/:id/image`: the BookOrbit author photo, with the cover rule (token checked when sent, anonymous requests follow `ABS_COMPAT_ANONYMOUS_COVERS`). BookOrbit keeps no author timestamps, so `addedAt`/`updatedAt` read 0, and `imagePath` is only a presence flag.
- `GET /api/libraries/:id/search?q=`: books through the BookOrbit quick search (audiobooks only, by relevance), series and authors by accent-insensitive name match. `limit` defaults to 12, max 50. Narrators, tags and genres come back empty.
- `GET /api/libraries/:id/collections` and `/playlists` answer an empty page, so the apps' browse trees load; BookOrbit collections are not mapped yet.

## Bookmarks (phase 3)

ABS keys a bookmark by item and time; BookOrbit audio bookmarks by a client id. `POST`, `PATCH /api/me/item/:id/bookmark` and `DELETE /api/me/item/:id/bookmark/:time` match the bookmark at that time within 0.05 seconds, which only absorbs the single-precision `real` the position is stored as. Creating at a time that already holds a bookmark renames it, as ABS does. Writes go through `AudiobookService`, so ownership, access and the end-of-book check are the web player's. `user.bookmarks` lists the user's audio bookmarks, newest first, capped at 1000.

## Live updates (socket)

The Android app keeps progress in memory from sign-in and only refreshes it from the socket event `user_item_progress_updated`; without a socket its home screen showed the sign-in position no matter how far the user listened, and it also hides the player's bookmark button while the socket is down. The app connects with socket.io at `<server address>/socket.io` over websocket only, so the gateway listens on `/api/v1/abs/socket.io`, a separate socket.io server from BookOrbit's own `/socket.io`. As in ABS the socket connects anonymously and sends `auth` with its access token; the token is checked like a media token (signed, sign-in session and token version still live, lifetime ignored because the app resends its stored token on reconnect), the socket joins a per-user room and gets `init` with `userId` and `username`, or `auth_failed`. Sockets that never authenticate are closed after 30 seconds. Read status changes made anywhere else in BookOrbit (web, KOReader, Kobo) are pushed the same way through BookOrbit's `book.status-changed` event. Bookmarks are not pushed: BookOrbit has no bookmark event, so bookmarks added in the web player reach the app on its next launch. Every progress write that changed the stored position (live sync and close, offline sessions, PATCH and batch) pushes the stored progress to that user's sockets; it is skipped without a query when none is connected, and a failure only logs `[abs.progress_publish] [fail]`.

## User object

`user.token` is always empty. ABS 2.26 moved to JWTs and kept `user.token` only for the old API token; on every launch the Android app compares it with the access token it holds and, when they match, signs the user out with "Authentication has been improved for security in server v2.26.0". ABS returns it empty for the root user, so clients already cope with an empty value.

Finished state: a status of `read`, or a position at 100% unless the user set the book back to `unread` or `want_to_read`. BookOrbit keeps the position when the status is set by hand, so a finished book moved back to unread is reported at 0:00, not finished, matching the play endpoint, which starts a completed position from the beginning.

`GET /api/me` and `POST /api/authorize` return the ABS user (`User.toOldJSONForBrowser`): `id`, `username`, `email`, `type` (`"admin"` for superusers, else `"user"`), `token`, `mediaProgress` (above), `seriesHideFromContinueListening: []`, `bookmarks` (from audiobook bookmarks, phase 3; `[]` before), `isActive`, `isLocked: false`, `lastSeen`, `createdAt`, `permissions` (all `false` except `download: true`, `update: false`, `delete: false`, `upload: false`, `accessAllLibraries`, `accessAllTags: true`, `accessExplicitContent: true`), `librariesAccessible` (encoded library ids), `itemTagsSelected: []`.

`/api/authorize` wraps it: `{ user, userDefaultLibraryId, serverSettings, ereaderDevices: [], Source: "docker" }`. `serverSettings` needs at least `id: "server-settings"`, `version: ABS_COMPAT_SERVER_VERSION`, `language: "en-us"`, `scannerFindCovers: false`, `sortingIgnorePrefix: false`, `chromecastEnabled: false`.

`/api/me` does not include `accessToken`/`refreshToken` (only `/login` and `/auth/refresh` do).

## Permissions

- Gate the whole module with an existing permission if one fits audiobook playback; otherwise the user only needs library access, which every book check already enforces.
- Superusers get no bypass beyond what `BookService.verifyBookAccess` already allows.
- All write endpoints only touch the caller's own progress, bookmarks and stats.

## Observability

- `[abs.login]`, `[abs.refresh]`, `[abs.session_sync_local]` start/end/fail logs per CLAUDE.md. `[abs.session_sync_local] [end] userId=.. sessions=.. applied=.. skippedOlder=.. failed=..`.
- No logs per stream range request or per progress sync tick (hot paths); fail logs only.
- **Unknown-route log:** a catch-all under `/api/v1/abs/*` registered last that logs `[abs.unsupported_route] method=GET path="/api/..." userAgent="..."` (sanitized, query string stripped so tokens never reach logs) and returns 404. This is how SoundLeaf's needs are found.
- Never log tokens, `x-refresh-token`, or the `token` query parameter.

## Testing

Vitest, `.test.ts`, `Test.createTestingModule()`.

- `abs-ids`: round trip, rejection of malformed ids.
- Serializers: snapshot-free assertions on the fields clients read, built from a realistic multi-file manifest (3 MP3 tracks, chapters spanning a file boundary) and a single M4B.
- `applyExternalPosition`: absolute to (asset, offset) conversion at boundaries, clamp, older timestamp ignored, equal timestamp idempotent, future timestamp clamped, finished, revision conflict retry, access denied for another user's book.
- Merge scenarios from the Progress section, end to end through `AbsSessionService` with a mocked audiobook service.
- Auth: login refuses OIDC-only and wrong password, refresh rotates, media guard accepts an expired JWT with an active session and refuses a revoked session or bumped `tokenVersion`.
- Manual: the official Android app and SoundLeaf against a dev server: login, browse, stream with seek, download, airplane mode listening, reconnect sync, Android Auto and CarPlay browse.

## Phases

1. **Connect and stream**: `/status`, `/ping`, `/login`, `/auth/refresh`, `/logout`, `/api/me`, `/api/authorize`, `/api/libraries`, `/api/libraries/:id`, `/api/libraries/:id/items`, `/api/items/:id`, cover, file stream and download, `/api/items/:id/play`, unknown-route log.
2. **Progress and offline**: `applyExternalPosition`, `/api/session/:id/sync|close`, `/api/session/local`, `/api/session/local-all`, `/api/me/progress/*` (GET, PATCH, batch, DELETE), `user.mediaProgress`, `/api/libraries/:id/personalized`, `/api/me/items-in-progress`.
3. **Polish**: series, authors, search, bookmarks (`/api/me/item/:id/bookmark`), listening stats. Done. Next: whatever the unknown-route log shows SoundLeaf needs once the phones connect.

## Implementation notes

Differences found while checking the design against the ABS 2.37 server and the 0.14 app source.

- **Direct play uses a second URL.** From server version 2.22 the apps do not play `tracks[].contentUrl`. They request `GET /public/session/<sessionId>/track/<index>` with no credentials, where `<index>` is the 1-based track index. That route is implemented (`/api/v1/abs/public/session/...`). Because it carries no token, the playback session id is a signed capability: `ps-<bookId>-<userId>-<signInSessionId>-<method>-<nonce>-<mac>`, with the mac an HMAC of those parts under the JWT secret. The route checks the mac and that the sign-in session and token version are still live on every request, exactly like a media token.
- **Covers are requested without credentials.** From server version 2.17 the apps drop the token from cover URLs, as ABS itself serves covers anonymously. A cover request that carries a token gets the normal access check. One without a token gets the audiobook cover of the book id, and only for books that have audio files. Set `ABS_COMPAT_ANONYMOUS_COVERS=false` to refuse anonymous covers; the apps then show no cover art.
- **Bodies are read leniently.** The global `ValidationPipe` uses `forbidNonWhitelisted`, which would turn any field the apps add into a 400. ABS bodies are therefore read field by field in the services, not through DTO classes.
- **`GET /api/items/:id`** always returns the expanded item, with or without `expanded=1`.
- **Range requests** follow RFC 9110: an end past the file is clamped, a suffix range is served, and only a start past the file answers 416. The web player's asset route shares this helper.
- **Success bodies are `OK`.** The Android app treats an empty 200 body as a failed request, so `session/:id/sync`, `session/:id/close`, `session/local` and the progress `PATCH` and `DELETE` answer `OK` as plain text, as ABS does.
- **`local-all` works per book.** The apps delete every saved session once the request succeeds, so nothing may be dropped silently. Only the newest session per book can change progress, so the others are answered as synced without a write. The cap of 500 applies to distinct books, and more than 5000 entries in one request is a 400. A single `session/local` for an unknown item answers 404 so the app keeps the session.
- **Replaying an identical position is a no-op.** An update with the stored `capturedAt` and the same position is reported as not applied instead of bumping the revision again.
- **Not finished rewinds instead of deleting.** `PATCH` with `isFinished: false` writes the given position (default 0). Deleting the row instead left a read book at `read`, because with no earlier position there is no reread evidence, so the apps kept showing it as finished. Found by the real-database run.
- **Text `OK` only on success.** A route-level `Content-Type: text/plain` header also applied to the JSON body of an error, which Fastify refused to send, so every 404 and 400 on the `OK` routes (progress PATCH/DELETE, session sync/close/local, bookmark DELETE) became a 500. The type is now set only once the work succeeded (`abs-reply.ts`). Found by the real-database run.
- **Item facts aliases.** The per-page facts subquery names its columns `audio_*`: Drizzle selects subquery columns by bare alias, and `duration_seconds` collided with `book_metadata.duration_seconds`. Found by the real-database run.
- **`user.mediaProgress` takes two queries**, one for the progress rows and one for the audio files of those books (needed to turn a position inside a file into an absolute one), whatever the number of books, capped at 1000.
- **OIDC-only users** are refused by the ordinary credential check: they hold a random password, so `AuthService.login` answers 401 and counts it like any failed sign-in.

## Open risks

- SoundLeaf is closed source; it may call endpoints or require fields not listed here. Mitigation: unknown-route log and device testing before calling a phase done.
- SoundLeaf subpath support is unverified (see Mounting fallback).
- ABS clients evolve; pinning `serverVersion` to `2.26.0` limits which feature gates they enable.
- Read status vs. `isFinished`: BookOrbit can mark a book finished through other paths (web, Kobo). `isFinished` reads read status so those show as finished in the apps too.
