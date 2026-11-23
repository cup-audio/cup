import http from "node:http";

export type SharedPage = {
  url(pathAndQuery: string): string;
  close(): Promise<void>;
};

export const SHARED_PAGE_HEADING = "Shared article";

export async function startSharedPage(): Promise<SharedPage> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>${SHARED_PAGE_HEADING}</title><h1>${SHARED_PAGE_HEADING}</h1>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The shared page's server has no TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: (pathAndQuery) => `${origin}${pathAndQuery}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
