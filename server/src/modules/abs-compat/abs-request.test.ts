import { bearerToken, deriveDeviceLabel, includesFlag, parseListQuery, readBoolean, readFiniteNumber } from './abs-request';

describe('parseListQuery', () => {
  it('defaults and caps the page size', () => {
    expect(parseListQuery({}, 50, 200)).toEqual({ limit: 50, page: 0, sort: '', desc: false, filter: '', minified: false });
    expect(parseListQuery({ limit: '100', page: '3', sort: 'addedAt', desc: '1', minified: '1', filter: 'x' }, 50, 200)).toEqual({
      limit: 100,
      page: 3,
      sort: 'addedAt',
      desc: true,
      filter: 'x',
      minified: true,
    });
    expect(parseListQuery({ limit: '100000' }, 50, 200).limit).toBe(200);
  });

  it.each([['0'], ['-5'], ['abc'], ['']])('uses the default page size for limit %j', (limit) => {
    expect(parseListQuery({ limit }, 50, 200).limit).toBe(50);
  });

  it('never goes below the first page', () => {
    expect(parseListQuery({ page: '-2' }, 50, 200).page).toBe(0);
    expect(parseListQuery({ page: 'x' }, 50, 200).page).toBe(0);
  });
});

describe('request readers', () => {
  it('reads numbers, booleans and flags leniently', () => {
    expect(readFiniteNumber({ a: 5 }, 'a')).toBe(5);
    expect(readFiniteNumber({ a: '5.5' }, 'a')).toBe(5.5);
    expect(readFiniteNumber({ a: 'x' }, 'a')).toBeUndefined();
    expect(readFiniteNumber({ a: Number.NaN }, 'a')).toBeUndefined();
    expect(readFiniteNumber({ a: '' }, 'a')).toBeUndefined();
    expect(readBoolean({ a: true }, 'a')).toBe(true);
    expect(readBoolean({ a: 'false' }, 'a')).toBe(false);
    expect(readBoolean({ a: 'maybe' }, 'a')).toBeUndefined();
    expect(includesFlag({ include: 'progress, rssfeed' }, 'progress')).toBe(true);
    expect(includesFlag({ include: 'rssfeed' }, 'progress')).toBe(false);
    expect(includesFlag({}, 'progress')).toBe(false);
  });

  it('extracts a bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('deriveDeviceLabel', () => {
  it.each([
    ['SoundLeaf/2.1 CFNetwork/1494 Darwin/23.4', 'SoundLeaf (iOS)'],
    ['okhttp/4.12.0', 'Audiobookshelf app (Android)'],
    ['audiobookshelf/0.14 (Linux; Android 14)', 'Audiobookshelf app (Android)'],
    ['Audiobookshelf/0.14 (iPhone; iOS 17.4) Alamofire/5', 'Audiobookshelf app (iOS)'],
    ['curl/8', 'Audiobookshelf client'],
    [undefined, 'Audiobookshelf client'],
  ])('labels %j as %s', (userAgent, label) => {
    expect(deriveDeviceLabel(userAgent)).toBe(label);
  });
});
