const BUFFER_LIMIT = 64 * 1024;

export type DataChannelTransport = {
  channel: RTCDataChannel;
  send: (message: string, key?: string) => boolean;
  close: () => void;
};

/** Queue complete messages until the channel opens or its send buffer drains. */
export function queueDataChannel(channel: RTCDataChannel, maxPending = 256): DataChannelTransport {
  const pending: { message: string; key?: string }[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    if (disposed || channel.readyState !== 'open') return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    while (pending.length && channel.bufferedAmount < BUFFER_LIMIT) {
      try {
        channel.send(pending[0].message);
        pending.shift();
      } catch {
        // Some browsers reject send before reporting a full SCTP buffer.
        retryTimer = setTimeout(flush, 100);
        return;
      }
    }
  };

  const dispose = () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    pending.length = 0;
    channel.removeEventListener('open', flush);
    channel.removeEventListener('bufferedamountlow', flush);
    channel.removeEventListener('close', dispose);
  };

  channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
  channel.addEventListener('open', flush);
  channel.addEventListener('bufferedamountlow', flush);
  channel.addEventListener('close', dispose);

  return {
    channel,
    send: (message, key) => {
      if (disposed || channel.readyState === 'closing' || channel.readyState === 'closed') return false;
      const existing = key === undefined ? undefined : pending.find(item => item.key === key);
      if (existing) existing.message = message;
      else {
        // Never silently displace an SDP offer with newer ICE candidates.
        if (pending.length >= maxPending) return false;
        pending.push({ message, key });
      }
      flush();
      return true;
    },
    close: () => {
      dispose();
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    },
  };
}
