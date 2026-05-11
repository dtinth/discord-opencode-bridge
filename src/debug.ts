import consola from "consola";
import { config } from "./config";

// Set debug level if DEBUG env var matches our namespace
if (process.env.DEBUG?.includes("bridge")) {
  consola.level = 5;
}

// Toggle debug on SIGUSR1 at runtime
process.on("SIGUSR1", () => {
  if (consola.level >= 5) {
    consola.level = 4;
    consola.info("debug logging disabled");
  } else {
    consola.level = 5;
    consola.info("debug logging enabled");
  }
});

export const log = consola.withTag("bridge");
