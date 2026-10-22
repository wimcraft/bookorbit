import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { makeUser } from '../abs-test-support';
import { AbsMediaTokenGuard, extractMediaTokens } from './abs-media-token.guard';

function context(request: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe('extractMediaTokens', () => {
  it('reads the bearer header and the query token, bearer first and without duplicates', () => {
    expect(extractMediaTokens({ headers: { authorization: 'Bearer abc' }, query: { token: 'def' } } as never)).toEqual(['abc', 'def']);
    expect(extractMediaTokens({ headers: { authorization: 'Bearer abc' }, query: { token: 'abc' } } as never)).toEqual(['abc']);
    expect(extractMediaTokens({ headers: {}, query: { token: 'def' } } as never)).toEqual(['def']);
    expect(extractMediaTokens({ headers: { authorization: 'Basic zzz' }, query: {} } as never)).toEqual([]);
    expect(extractMediaTokens({ headers: {}, query: { token: ['first', 'second'] } } as never)).toEqual(['first']);
  });
});

describe('AbsMediaTokenGuard', () => {
  it('authenticates with the query token and attaches the user', async () => {
    const user = makeUser();
    const auth = { verifyMediaToken: vi.fn().mockResolvedValue(user) };
    const request: Record<string, unknown> = { headers: {}, query: { token: 'tok' } };

    await expect(new AbsMediaTokenGuard(auth as never).canActivate(context(request))).resolves.toBe(true);

    expect(auth.verifyMediaToken).toHaveBeenCalledWith('tok');
    expect(request.user).toBe(user);
  });

  it('falls back to the query token when the bearer header is stale', async () => {
    const user = makeUser();
    const auth = { verifyMediaToken: vi.fn(async (token: string) => (token === 'good' ? user : Promise.reject(new UnauthorizedException()))) };
    const request: Record<string, unknown> = { headers: { authorization: 'Bearer stale' }, query: { token: 'good' } };

    await new AbsMediaTokenGuard(auth as never).canActivate(context(request));

    expect(auth.verifyMediaToken.mock.calls.map(([token]) => token)).toEqual(['stale', 'good']);
    expect(request.user).toBe(user);
  });

  it('refuses a request with no usable token', async () => {
    const auth = { verifyMediaToken: vi.fn().mockRejectedValue(new UnauthorizedException()) };
    const guard = new AbsMediaTokenGuard(auth as never);

    await expect(guard.canActivate(context({ headers: {}, query: {} }))).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context({ headers: {}, query: { token: 'bad' } }))).rejects.toThrow(UnauthorizedException);
  });

  it('does not swallow failures other than a refused token', async () => {
    const auth = { verifyMediaToken: vi.fn().mockRejectedValue(new Error('db down')) };

    await expect(new AbsMediaTokenGuard(auth as never).canActivate(context({ headers: {}, query: { token: 't' } }))).rejects.toThrow('db down');
  });

  it('keeps the default password gate of the normal guard', async () => {
    const auth = { verifyMediaToken: vi.fn().mockResolvedValue(makeUser(7, { isDefaultPassword: true })) };
    const guard = new AbsMediaTokenGuard(auth as never);

    await expect(guard.canActivate(context({ headers: {}, query: { token: 't' } }))).rejects.toThrow(ForbiddenException);

    auth.verifyMediaToken.mockResolvedValue(makeUser(7, { isDefaultPassword: true, authenticationMethod: 'oidc' }));
    await expect(guard.canActivate(context({ headers: {}, query: { token: 't' } }))).resolves.toBe(true);
  });
});
