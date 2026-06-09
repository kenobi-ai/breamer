import { logger } from "./logger.js";
import { startServer } from "./server.js";

startServer().catch((error) => {
  logger.error("Container process failed", error);
  process.exit(1);
});
