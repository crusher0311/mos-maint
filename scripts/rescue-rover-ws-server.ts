import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { handleMediaStream } from "../lib/rescue-rover/media-stream-handler";

const WS_PORT = parseInt(process.env.RESCUE_ROVER_WS_PORT || "3002", 10);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "rescue-rover-ws" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname === "/ws/twilio-media") {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      console.log("[RescueRover WS] Twilio media stream connection established");
      handleMediaStream(ws);
    });
  } else {
    console.log(`[RescueRover WS] Rejected connection to ${url.pathname}`);
    socket.destroy();
  }
});

server.listen(WS_PORT, "0.0.0.0", () => {
  console.log(`[RescueRover WS] WebSocket server listening on port ${WS_PORT}`);
  console.log(`[RescueRover WS] Twilio media stream endpoint: ws://0.0.0.0:${WS_PORT}/ws/twilio-media`);
});

process.on("SIGTERM", () => {
  console.log("[RescueRover WS] Shutting down...");
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[RescueRover WS] Shutting down...");
  wss.close();
  server.close();
  process.exit(0);
});
