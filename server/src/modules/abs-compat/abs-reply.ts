import type { FastifyReply } from 'fastify';

/**
 * The Android app treats an empty 200 as a failure, so these routes answer `OK` as text, as ABS does. The
 * type is set only once the work has succeeded: a route-level text/plain header would also apply to the
 * JSON body of an error, which Fastify then refuses to send, turning every 404 into a 500.
 */
export function okText(reply: FastifyReply): string {
  reply.type('text/plain');
  return 'OK';
}
