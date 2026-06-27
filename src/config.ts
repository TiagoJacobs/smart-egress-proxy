/**
 * Configuration loading and validation.
 *
 * The full configuration is supplied as a JSON string in the SEP_CONFIG
 * environment variable. loadConfig() parses it, validates it with zod, applies
 * every documented default, and returns a fully-populated AppConfig. On any
 * problem it throws a single Error whose message lists all issues.
 */

import { z } from "zod";
import type { AppConfig } from "./types.js";

const monitoredUrlSchema = z.object({
  url: z.string().url(),
  expectedResponseCode: z.number().int().default(200),
  fetchBytesLimit: z.number().int().positive().default(1_048_576),
  acceptedResponseTimeMs: z.number().int().positive().default(2000),
});

const upstreamProxySchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  priorityOrder: z.number().int(),
});

const credentialsSchema = z
  .object({
    anonymous: z.boolean().default(true),
    user: z.string().optional(),
    pass: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.anonymous && (!c.user || !c.pass)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user and pass are required when anonymous is false",
      });
    }
  })
  .default({});

const settingsSchema = z
  .object({
    probeIntervalMinutes: z.number().positive().default(5),
    directPriorityOrder: z.number().int().default(100),
    defaultMode: z
      .string()
      .regex(
        /^(AUTO|DIRECT|PROXY:\d+)$/i,
        'defaultMode must be "AUTO", "DIRECT" or "PROXY:<index>"',
      )
      .default("AUTO"),
  })
  .default({});

const appConfigSchema = z.object({
  monitoredUrls: z.array(monitoredUrlSchema).default([]),
  upstreamProxies: z.array(upstreamProxySchema).default([]),
  settings: settingsSchema,
  adminDashboardCredentials: credentialsSchema,
  proxyCredentials: credentialsSchema,
});

/**
 * Load, parse and validate the configuration from process.env.SEP_CONFIG.
 * Throws a human-readable Error listing all problems if the value is missing,
 * not valid JSON, or fails schema validation.
 */
export function loadConfig(): AppConfig {
  const raw = process.env.SEP_CONFIG;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "SEP_CONFIG environment variable is not set. Provide the configuration as a JSON string (see config.json.example).",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SEP_CONFIG is not valid JSON: ${(err as Error).message}`);
  }

  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid SEP_CONFIG:\n${problems}`);
  }

  return result.data;
}
