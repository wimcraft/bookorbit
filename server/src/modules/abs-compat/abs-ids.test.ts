import { NotFoundException } from '@nestjs/common';

import {
  decodeItemId,
  decodeLibraryId,
  decodePlaybackSessionBookId,
  decodeProgressId,
  decodeProgressReference,
  encodeItemId,
  encodeLibraryId,
  encodeMediaId,
  encodePlaybackSessionId,
  encodeProgressId,
  encodeUserId,
  verifyPlaybackSessionId,
} from './abs-ids';

const SECRET = 'test-secret';
const SESSION = { bookId: 1287, userId: 4, authSessionId: 19, authMethod: 'password' };

describe('abs ids', () => {
  it('round-trips library, item and progress ids', () => {
    expect(encodeLibraryId(3)).toBe('lib-3');
    expect(decodeLibraryId(encodeLibraryId(3))).toBe(3);
    expect(encodeItemId(1287)).toBe('li-1287');
    expect(decodeItemId(encodeItemId(1287))).toBe(1287);
    expect(encodeProgressId(1287)).toBe('mp-1287');
    expect(decodeProgressId(encodeProgressId(1287))).toBe(1287);
    expect(encodeMediaId(1287)).toBe('book-1287');
    expect(encodeUserId(4)).toBe('usr-4');
  });

  it.each([
    '',
    'li-',
    'li-0',
    'li-01',
    'li--1',
    'li-1.5',
    'li-1e3',
    'li-12abc',
    ' li-1',
    'li-1 ',
    'LI-1',
    'lib-1',
    'li-99999999999',
    'li-2147483648',
    '../li-1',
  ])('rejects the malformed item id %j', (value) => {
    expect(() => decodeItemId(value)).toThrow(NotFoundException);
  });

  it.each([undefined, null, 12, {}, ['li-1']])('rejects a non-string item id %j', (value) => {
    expect(() => decodeItemId(value)).toThrow(NotFoundException);
  });

  it('does not accept an id of another kind', () => {
    expect(() => decodeLibraryId('li-1')).toThrow(NotFoundException);
    expect(() => decodeProgressId('li-1')).toThrow(NotFoundException);
  });

  it('lets a progress reference be a progress id or the library item id', () => {
    expect(decodeProgressReference('mp-8')).toBe(8);
    expect(decodeProgressReference('li-8')).toBe(8);
    expect(() => decodeProgressReference('book-8')).toThrow(NotFoundException);
  });

  describe('playback session ids', () => {
    it('carries the book and verifies against the secret', () => {
      const id = encodePlaybackSessionId(SECRET, SESSION);

      expect(id).toMatch(/^ps-1287-4-19-p-[0-9a-f]{16}-[0-9a-f]{32}$/);
      expect(decodePlaybackSessionBookId(id)).toBe(1287);
      expect(verifyPlaybackSessionId(SECRET, id)).toEqual(
        expect.objectContaining({ bookId: 1287, userId: 4, authSessionId: 19, authMethod: 'password' }),
      );
    });

    it('issues a different id each time', () => {
      expect(encodePlaybackSessionId(SECRET, SESSION)).not.toBe(encodePlaybackSessionId(SECRET, SESSION));
    });

    it('rejects an id signed with another secret', () => {
      expect(() => verifyPlaybackSessionId('other-secret', encodePlaybackSessionId(SECRET, SESSION))).toThrow(NotFoundException);
    });

    it.each([
      ['book', (id: string) => id.replace('ps-1287-', 'ps-1288-')],
      ['user', (id: string) => id.replace('-4-19-', '-5-19-')],
      ['sign-in session', (id: string) => id.replace('-4-19-', '-4-20-')],
      ['auth method', (id: string) => id.replace('-19-p-', '-19-o-')],
      ['signature', (id: string) => `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`],
    ])('rejects an id whose %s was altered', (_name, tamper) => {
      const id = encodePlaybackSessionId(SECRET, SESSION);
      expect(() => verifyPlaybackSessionId(SECRET, tamper(id))).toThrow(NotFoundException);
    });

    it('does not read a book out of a client generated local session id', () => {
      expect(() => decodePlaybackSessionBookId('play_local_8f6f1c')).toThrow(NotFoundException);
      expect(() => decodePlaybackSessionBookId('ps-1-2-3')).toThrow(NotFoundException);
    });
  });
});
