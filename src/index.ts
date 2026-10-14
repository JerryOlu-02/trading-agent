import { serve } from "@hono/node-server";
import { createApi } from "./api/server.js";
import { Pit } from "./agent.js";
import { loadSettings } from "./config.js";
import { Store } from "./db/schema.js";

const settings = loadSettings();
const store = new Store();
const pit = new Pit(settings, store);

serve(
  {
    fetch: createApi(pit, settings.allowedOrigins).fetch,
    hostname: settings.host,
    port: settings.port,
  },
  (info) => {
    const callers =
      settings.allowedOrigins.length > 0
        ? settings.allowedOrigins.join(", ")
        : "http://localhost";
    store.log("info", `API listening on ${settings.host}:${info.port} for ${callers}`);
  },
);

pit.start();

function shutdown() {
  pit.stop();
  store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (error) => {
  const message =
    error instanceof Error ? error.message : "Unhandled rejection";
  store.log("error", message);
});
