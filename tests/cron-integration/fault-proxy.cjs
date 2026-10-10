const net = require("node:net");

// Test-owned loopback proxy only. No environment/configurable upstream.
async function faultProxy(port) {
  if (![27185, 55485].includes(port)) throw new Error("Not a disposable test port");
  const sockets = new Set();
  let fault = null;
  const server = net.createServer(client => {
    const upstream = net.connect(port, "127.0.0.1");
    let frames = Buffer.alloc(0);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("data", data => {
      if (fault?.direction === "request") {
        fault.bytes += data.length;
      } else {
        upstream.write(data);
      }
    });
    upstream.on("data", data => {
      if (fault?.direction === "response") {
        if (port === 55485) {
          // postgres-js unsafe() describes parameters before sending Execute.
          // Forward Parse/Describe replies; suppress execution results only.
          // TCP chunks need not coincide with PostgreSQL protocol frames.
          frames = Buffer.concat([frames, data]);
          while (frames.length >= 5) {
            const length = 1 + frames.readUInt32BE(1);
            if (length < 5 || length > 1024 * 1024) {
              client.destroy(new Error("Invalid PostgreSQL test frame"));
              return;
            }
            if (frames.length < length) break;
            const frame = frames.subarray(0, length);
            frames = frames.subarray(length);
            if (["D", "C", "Z"].includes(String.fromCharCode(frame[0]))) {
              fault.bytes += frame.length;
            } else {
              client.write(frame);
            }
          }
        } else {
          fault.bytes += data.length;
        }
      } else {
        client.write(data);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    arm(direction) {
      if (!["request", "response"].includes(direction) || fault) {
        throw new Error("Invalid fault transition");
      }
      fault = { direction, bytes: 0 };
      return fault;
    },
    cut() {
      // Keep the gate armed during driver reconnects until the operation settles.
      for (const socket of sockets) socket.destroy();
    },
    recover() { fault = null; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { faultProxy };
