const http = require("node:http");

const port = Number(process.env.PORT || 8787);
const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { if (body.length < 8192) body += chunk; });
  response.on("end", () => {
    try {
      const json = JSON.parse(body);
      process.exit(response.statusCode === 200 && json.status === "ready" ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
});
request.on("timeout", () => request.destroy(new Error("health_timeout")));
request.on("error", () => process.exit(1));
