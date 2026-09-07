import handler from 'vinext/server/fetch-handler';
export { LinkcastRoom } from './server/linkcast-room';

const worker = {
  fetch(request: Request, env: { ROOMS: DurableObjectNamespace }, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/api/socket') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      const room = url.searchParams.get('roomId') || '';
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(room)) return new Response('Invalid room', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    // Old polling clients must reload; never continue consuming D1 requests.
    if (url.pathname === '/api/rooms' || url.pathname === '/api/signals') return Response.json({ error: 'client_update_required' }, { status: 410 });
    return handler.fetch(request, env, ctx);
  },
};
export default worker;
