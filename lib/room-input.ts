/** Use the same room identifier for pasted links, shared URLs, and plain codes. */
export function normalizeRoomValue(value: string): string {
  const input = value.trim().replace(/\\&/g, '&').replace(/&amp;/gi, '&');
  const markdown = input.match(/^\[[\s\S]*?\]\((https?:\/\/[^\s]+)\)$/);
  const text = markdown?.[1] || input;
  let room = text;
  try {
    if (/^https?:\/\//i.test(text)) room = new URL(text).searchParams.get('room') || '';
    else if (text.startsWith('?') || text.startsWith('/?')) {
      room = new URL(text, 'https://linkcast.invalid').searchParams.get('room') || '';
    }
  } catch { return ''; }
  room = room.trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(room)) return '';
  return /^[a-f0-9]{12}$/i.test(room) ? room.toLowerCase() : room;
}

export function createRoomLink(currentUrl: string, roomId: string): string {
  const room = normalizeRoomValue(roomId);
  if (!room) throw new Error('invalid_room');
  const url = new URL('/', currentUrl);
  url.search = new URLSearchParams({ room, mode: 'viewer' }).toString();
  return url.href;
}
