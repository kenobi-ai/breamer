import { WebSocket } from "ws";

interface PendingFrame {
  data: WebSocket.RawData;
  isBinary: boolean;
}

export interface PipeWebSocketOptions {
  onUpstreamError?: (err: Error) => void;
}

const sendFrame = (
  socket: WebSocket,
  data: WebSocket.RawData,
  isBinary: boolean
): void => {
  socket.send(data, { binary: isBinary });
};

export const pipeWebSockets = (
  client: WebSocket,
  upstream: WebSocket,
  options: PipeWebSocketOptions = {}
): void => {
  const pending: PendingFrame[] = [];

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      sendFrame(upstream, data, isBinary);
      return;
    }

    pending.push({ data, isBinary });
  });

  upstream.once("open", () => {
    for (const { data, isBinary } of pending) {
      sendFrame(upstream, data, isBinary);
    }
    pending.length = 0;
  });

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      sendFrame(client, data, isBinary);
    }
  });

  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason);
    }
  });

  client.on("close", (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(code, reason);
    } else {
      upstream.terminate();
    }
  });

  upstream.on("error", (err) => {
    options.onUpstreamError?.(err);
    if (client.readyState === WebSocket.OPEN) {
      client.close(1011, "CDP upstream error");
    }
  });
};
