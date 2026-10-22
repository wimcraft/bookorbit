import { NotFoundException } from '@nestjs/common';

import { AbsFallbackController, pathWithoutQuery } from './abs-fallback.controller';

describe('pathWithoutQuery', () => {
  it('drops the query string and fragment', () => {
    expect(pathWithoutQuery('/api/v1/abs/api/items/li-1/file/x?token=secret&a=b')).toBe('/api/v1/abs/api/items/li-1/file/x');
    expect(pathWithoutQuery('/api/v1/abs/status#frag')).toBe('/api/v1/abs/status');
    expect(pathWithoutQuery('/api/v1/abs/status')).toBe('/api/v1/abs/status');
    expect(pathWithoutQuery('/x?')).toBe('/x');
  });
});

describe('AbsFallbackController', () => {
  function setup() {
    const controller = new AbsFallbackController();
    const warn = vi.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    return { controller, warn };
  }

  it('logs the unsupported route without its query string and answers 404', () => {
    const { controller, warn } = setup();
    const req = { method: 'GET', url: '/api/v1/abs/api/me/listening-stats?token=eyJhbGciOi.secret.sig', headers: { 'user-agent': 'SoundLeaf/1.0' } };

    expect(() => controller.unsupported(req as never)).toThrow(NotFoundException);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      '[abs.unsupported_route] method=GET path="/api/v1/abs/api/me/listening-stats" userAgent="SoundLeaf/1.0" - route not supported',
    );
    expect(String(warn.mock.calls[0]![0])).not.toContain('secret');
  });

  it('keeps a hostile path or user agent on one line inside its quotes', () => {
    const { controller, warn } = setup();
    const req = { method: 'POST', url: '/api/v1/abs/x"\n[fake] [end]', headers: { 'user-agent': 'a"b\\c\r\nd' } };

    expect(() => controller.unsupported(req as never)).toThrow(NotFoundException);

    const line = String(warn.mock.calls[0]![0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('path="/api/v1/abs/x\\" [fake] [end]"');
    expect(line).toContain('userAgent="a\\"b\\\\c  d"');
  });
});
