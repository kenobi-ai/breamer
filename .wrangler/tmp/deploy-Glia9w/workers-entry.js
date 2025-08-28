var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/workers-entry.ts
import { DurableObject } from "cloudflare:workers";
var workers_entry_default = {
  async fetch(request, env, ctx) {
    const id = env.BREAMER_CONTAINER.idFromName("main");
    const obj = env.BREAMER_CONTAINER.get(id);
    return await obj.fetch(request);
  }
};
var BreamerContainer = class extends DurableObject {
  static {
    __name(this, "BreamerContainer");
  }
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "localhost";
    url.port = "8080";
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: "half"
      });
      return response;
    } catch (error) {
      console.error("Container request failed:", error);
      return new Response("Container service unavailable", { status: 503 });
    }
  }
};
export {
  BreamerContainer,
  workers_entry_default as default
};
//# sourceMappingURL=workers-entry.js.map
