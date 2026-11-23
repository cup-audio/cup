import net from "node:net";

import { run } from "#src/host.ts";

export type LoopbackRelay = {
  close(): Promise<void>;
};

export async function startLoopbackRelay(port: number): Promise<LoopbackRelay | undefined> {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(port, "127.0.0.1");
    track(client);
    track(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "::1", resolve);
    });
  } catch (error) {
    if (await isListeningInThisProcess(port)) {
      return { close: () => Promise.resolve() };
    }
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      return undefined;
    }
    throw error;
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function isListeningInThisProcess(port: number): Promise<boolean> {
  const { exitCode, stdout, stderr } = await run(
    "lsof",
    ["-nP", "-a", `-iTCP@[::1]:${port}`, "-sTCP:LISTEN", "-t"],
    { successExitCodes: [0, 1] },
  );
  if (exitCode === 1) {
    if (stdout !== "" || stderr !== "") {
      throw new Error(`lsof failed for [::1]:${port}.\n${stdout}${stderr}`);
    }
    return false;
  }
  return stdout.split("\n").includes(String(process.pid));
}
