import { createServer } from "node:http";

const port = 4173;
const host = "127.0.0.1";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MakeADemo Railway Fixture</title>
  </head>
  <body>
    <main>
      <h1>MakeADemo Railway Fixture</h1>
      <p id="status" data-state="ready">Status: ready</p>
      <button id="demo-button" type="button">Complete demo interaction</button>
    </main>
    <script>
      document.querySelector("#demo-button").addEventListener("click", () => {
        const status = document.querySelector("#status");
        status.dataset.state = "complete";
        status.textContent = "Status: complete";
      });
    </script>
  </body>
</html>
`;

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
});

server.listen(port, host, () => {
  console.log(`localhost fixture listening at http://${host}:${port}/`);
});
