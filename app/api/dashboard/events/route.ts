import { NextRequest } from "next/server";

const clients = new Set<ReadableStreamDefaultController>();

export function notifyDashboardClients() {
  const message = `data: ${JSON.stringify({ type: "refresh", timestamp: Date.now() })}\n\n`;
  clients.forEach((controller) => {
    try {
      controller.enqueue(new TextEncoder().encode(message));
    } catch (e) {
      clients.delete(controller);
    }
  });
}

export async function GET(request: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      clients.add(controller);
      
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch (e) {
          clearInterval(keepAlive);
          clients.delete(controller);
        }
      }, 30000);

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        clients.delete(controller);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
