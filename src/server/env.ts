import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loopbackNames } from "./loopback";

export const env = createEnv({
  server: {
    MAYTAS_MODE: z.enum(["fake", "live"]),
    MAYTAS_URL: z.url().default("https://apprenticeships.chi.ac.uk/etrack"),
    MAYTAS_USERNAME: z.string().optional(),
    MAYTAS_PASSWORD: z.string().optional(),
    MAYFLY_HOST: z.string().default("127.0.0.1"),
    MAYFLY_PORT: z.coerce.number().int().min(1).max(65535).default(4747),
    MAYFLY_TOKEN: z.string().min(16).optional(),
    MAYFLY_DATA_DIR: z.string().default("./data"),
  },
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((value, ctx) => {
      if (value.MAYTAS_MODE === "live" && !(value.MAYTAS_USERNAME && value.MAYTAS_PASSWORD)) {
        ctx.addIssue({ code: "custom", message: "MAYTAS_USERNAME and MAYTAS_PASSWORD are required in live mode" });
      }
      if (!loopbackNames.has(value.MAYFLY_HOST) && !value.MAYFLY_TOKEN) {
        ctx.addIssue({ code: "custom", message: "MAYFLY_TOKEN is required when MAYFLY_HOST is not a loopback address" });
      }
    }),
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
