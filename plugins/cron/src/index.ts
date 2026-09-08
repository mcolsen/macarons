import type { Plugin } from "@opencode-ai/plugin"
import { cronPlugin } from "./plugin"

/**
 * @macarons/cron — server entry
 *
 * The host calls every function this module exports as a plugin, so the
 * real-clock instance is the only export here; the injectable factory lives
 * in ./plugin for the tests.
 */
export const CronPlugin: Plugin = cronPlugin()
