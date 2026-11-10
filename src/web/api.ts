import { hc } from "hono/client";
import type { AppType } from "../server/api";

/** Typed client for the Mayfly API. Requests go to the same origin and carry the session cookie. */
export const api = hc<AppType>("/", { init: { credentials: "same-origin" } });
