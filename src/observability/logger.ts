import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "pat",
  "token",
  "secret",
  "key",
  "authorization",
  "password",
  "req.headers.authorization",
  "req.headers.x-api-key",
  "req.headers['x-api-key']",
  "*.pat",
  "*.token",
  "*.secret",
  "*.key",
  "*.authorization",
  "*.password",
  "*.PERSONAL_ACCESS_TOKEN",
  "*.AZURE_CLIENT_SECRET",
  "*.clientSecret",
  "*.apiKey",
];

export function createLogger(opts?: {
  level?: string;
  destination?: NodeJS.WritableStream;
}): Logger {
  return pino(
    {
      level: opts?.level ?? process.env.LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: REDACT_PATHS,
        censor: "[Redacted]",
      },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      messageKey: "msg",
      base: undefined,
    },
    opts?.destination,
  );
}

export type { Logger };
