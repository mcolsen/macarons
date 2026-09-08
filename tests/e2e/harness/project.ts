import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { permissionStoreFile } from "../../../libraries/permission-rules/src/index"
import {
  approvalsJournalFile,
  blessFile,
  GLOBAL_SETTINGS_BASENAME,
  legacyProjectSettingsFile,
  projectSettingsFile,
  sha256Hex,
  worktreeConfigCandidates,
} from "../../../plugins/approve-for-me/src/shared"

export const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..")
export const PERSIST_PERMISSIONS_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "persist-permissions",
)
export const SERVER_ENTRY = path.join(
  PERSIST_PERMISSIONS_ROOT,
  "src",
  "index.ts",
)
export const TUI_ENTRY = path.join(PERSIST_PERMISSIONS_ROOT, "src", "tui.tsx")
export const AUTO_APPROVE_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "approve-for-me",
)
export const AUTO_APPROVE_SERVER_ENTRY = path.join(
  AUTO_APPROVE_ROOT,
  "src",
  "index.ts",
)
export const AUTO_APPROVE_TUI_ENTRY = path.join(
  AUTO_APPROVE_ROOT,
  "src",
  "tui.tsx",
)

export const BTW_ROOT = path.join(REPOSITORY_ROOT, "plugins", "btw")
export const BTW_SERVER_ENTRY = path.join(BTW_ROOT, "src", "index.ts")
export const BTW_TUI_ENTRY = path.join(BTW_ROOT, "src", "tui.tsx")

export const BACKGROUND_TASKS_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "background-tasks",
)
export const BACKGROUND_TASKS_SERVER_ENTRY = path.join(
  BACKGROUND_TASKS_ROOT,
  "src",
  "index.ts",
)
export const BACKGROUND_TASKS_TUI_ENTRY = path.join(
  BACKGROUND_TASKS_ROOT,
  "src",
  "tui.tsx",
)

export const CRON_ROOT = path.join(REPOSITORY_ROOT, "plugins", "cron")
export const CRON_SERVER_ENTRY = path.join(CRON_ROOT, "src", "index.ts")

export const SUBAGENT_COMMS_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "subagent-comms",
)
export const SUBAGENT_COMMS_SERVER_ENTRY = path.join(
  SUBAGENT_COMMS_ROOT,
  "src",
  "index.ts",
)
export const REDACT_SECRETS_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "redact-secrets",
)
export const REDACT_SECRETS_SERVER_ENTRY = path.join(
  REDACT_SECRETS_ROOT,
  "src",
  "index.ts",
)
export const WEB_SEARCH_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "web-search",
)
export const WEB_SEARCH_SERVER_ENTRY = path.join(
  WEB_SEARCH_ROOT,
  "src",
  "index.ts",
)

export const SCOPED_SYSTEM_PROMPTS_ROOT = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "scoped-system-prompts",
)
export const SCOPED_SYSTEM_PROMPTS_SERVER_ENTRY = path.join(
  SCOPED_SYSTEM_PROMPTS_ROOT,
  "src",
  "index.ts",
)

// A project configured with two scripted models and the scoped-system-prompts
// server plugin. The alternate model lets its journey prove unmatched prompts
// keep the host's system-prompt array unchanged.
export async function writeScopedSystemPromptsConfig(
  project: string,
  providerBaseURL: string,
  pluginOptions: Record<string, unknown>,
) {
  const entry = pathToFileURL(SCOPED_SYSTEM_PROMPTS_SERVER_ENTRY).href
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scoped model",
            limit: { context: 32_000, output: 4_096 },
          },
          other: {
            name: "E2E unmatched model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    plugin: [[entry, pluginOptions]],
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

// A project configured with the scripted provider and the web-search server
// half. `permission` defaults to allowing websearch (the same action the
// builtin asserts) so the scripted tool call runs without an interactive
// prompt.
export async function writeWebSearchConfig(
  project: string,
  providerBaseURL: string,
  options: {
    permission?: Record<string, unknown>
    serverPlugin?: boolean
    pluginOptions?: Record<string, unknown>
  } = {},
) {
  const entry = pathToFileURL(WEB_SEARCH_SERVER_ENTRY).href
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    permission: options.permission ?? { websearch: "allow" },
    ...(options.serverPlugin === false
      ? {}
      : {
          plugin: [
            options.pluginOptions ? [entry, options.pluginOptions] : entry,
          ],
        }),
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

// A project configured with the scripted provider and the redact-secrets
// server half. Bash is allowed so the scripted tool calls that read and write
// secret-bearing files run without an interactive prompt.
export async function writeRedactSecretsConfig(
  project: string,
  providerBaseURL: string,
  options: {
    permission?: Record<string, unknown>
    serverPlugin?: boolean
  } = {},
) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    permission: options.permission ?? { bash: "allow" },
    ...(options.serverPlugin === false
      ? {}
      : { plugin: [pathToFileURL(REDACT_SECRETS_SERVER_ENTRY).href] }),
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

/**
 * The env-key-loaded variant: opencode.json carries NO provider entry at
 * all. The provider comes from a crafted models.dev snapshot (written to
 * `modelsPath`, which both the host and the plugin read when
 * OPENCODE_MODELS_PATH points at it) plus an API-key environment variable —
 * the /connect-and-env activation path whose title-generation requests the
 * wire backstop must cover without any config.provider entry to hang off.
 */
export const ENV_PROVIDER_ID = "e2eenv"
export const ENV_PROVIDER_KEY_VAR = "E2EENV_API_KEY"

export async function writeRedactSecretsEnvProviderProject(
  project: string,
  modelsPath: string,
  providerBaseURL: string,
) {
  const catalog = {
    [ENV_PROVIDER_ID]: {
      id: ENV_PROVIDER_ID,
      name: "E2E env-loaded provider",
      env: [ENV_PROVIDER_KEY_VAR],
      npm: "@ai-sdk/openai-compatible",
      api: providerBaseURL,
      models: {
        test: {
          id: "test",
          name: "E2E scripted model",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 32_000, output: 4_096 },
        },
      },
    },
  }
  await fs.writeFile(modelsPath, `${JSON.stringify(catalog, null, 2)}\n`)
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${ENV_PROVIDER_ID}/test`,
    permission: { bash: "allow" },
    plugin: [pathToFileURL(REDACT_SECRETS_SERVER_ENTRY).href],
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

// A project configured with the scripted provider and the background-tasks
// server half. `permission` defaults to allowing bash so background_run (which
// asserts the same "bash" action) runs without an interactive prompt.
export async function writeBackgroundTasksConfig(
  project: string,
  providerBaseURL: string,
  options: {
    permission?: Record<string, unknown>
    serverPlugin?: boolean
    pluginOptions?: Record<string, unknown>
  } = {},
) {
  const entry = pathToFileURL(BACKGROUND_TASKS_SERVER_ENTRY).href
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    permission: options.permission ?? { bash: "allow" },
    ...(options.serverPlugin === false
      ? {}
      : {
          plugin: [
            options.pluginOptions ? [entry, options.pluginOptions] : entry,
          ],
        }),
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

// A project configured with the scripted provider and the subagent-comms
// server half. `permission` defaults to allowing bash so a child turn can run
// shell steps without an interactive prompt; the "task" action subagent_spawn
// asserts is already allowed by the default ruleset.
export async function writeSubagentCommsConfig(
  project: string,
  providerBaseURL: string,
  options: {
    permission?: Record<string, unknown>
    pluginOptions?: Record<string, unknown>
  } = {},
) {
  const entry = pathToFileURL(SUBAGENT_COMMS_SERVER_ENTRY).href
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
          alternate: {
            name: "E2E alternate subagent model",
            limit: { context: 32_000, output: 4_096 },
            variants: {
              high: { scripted_marker: "subagent-alternate-high" },
            },
          },
        },
      },
    },
    permission: options.permission ?? { bash: "allow" },
    plugin: [options.pluginOptions ? [entry, options.pluginOptions] : entry],
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

// A project configured with the scripted provider and the btw server half.
// `permission` defaults to allowing bash so a parent turn can complete without
// interaction; the fork's own "ask" rules still override it inside the fork.
export async function writeBtwConfig(
  project: string,
  providerBaseURL: string,
  options: {
    permission?: Record<string, unknown>
    serverPlugin?: boolean
  } = {},
) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: providerBaseURL },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    permission: options.permission ?? { bash: "allow" },
    ...(options.serverPlugin === false
      ? {}
      : { plugin: [pathToFileURL(BTW_SERVER_ENTRY).href] }),
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

export async function writeProjectConfig(
  project: string,
  providerBaseURL: string,
  options: {
    serverPlugin?: boolean
    permission?: Record<string, unknown>
    /** Absolute plugin entry paths; overrides the default persist-permissions entry. */
    plugins?: string[]
  } = {},
) {
  const plugins =
    options.plugins ?? (options.serverPlugin === false ? [] : [SERVER_ENTRY])
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/test",
    provider: {
      e2e: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E scripted provider",
        options: {
          apiKey: "e2e-not-a-secret",
          baseURL: providerBaseURL,
        },
        models: {
          test: {
            name: "E2E scripted model",
            limit: { context: 32_000, output: 4_096 },
          },
          // A second model on the same scripted endpoint, so suites can pin
          // the Approve for Me classifier away from the session model and assert
          // which one actually served the classification. Its "boost" variant
          // carries a marker option; openai-compatible passes unknown option
          // keys through to the request body, so suites can assert the
          // variant was actually applied by the host.
          classifier: {
            name: "E2E scripted classifier model",
            limit: { context: 32_000, output: 4_096 },
            variants: { boost: { scripted_marker: "variant-boost" } },
          },
        },
      },
    },
    permission: options.permission ?? { bash: "ask" },
    ...(plugins.length
      ? { plugin: plugins.map((entry) => pathToFileURL(entry).href) }
      : {}),
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return config
}

export async function writeTuiConfig(
  project: string,
  entries: string[] = [TUI_ENTRY],
) {
  const directory = path.join(project, ".opencode")
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "tui.json")
  await fs.writeFile(
    file,
    `${JSON.stringify({ plugin: entries.map((entry) => pathToFileURL(entry).href) }, null, 2)}\n`,
  )
  return file
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T
}

export function storeFile(configDir: string, project: string) {
  return permissionStoreFile(configDir, project)
}

export function autoApproveSettingsFile(configDir: string, project: string) {
  return projectSettingsFile(configDir, project)
}

export function autoApproveGlobalSettingsFile(configDir: string) {
  return path.join(configDir, GLOBAL_SETTINGS_BASENAME)
}

/** Records the Approve for Me blessing over every worktree opencode.json[c]
 *  candidate currently on disk — the e2e stand-in for the TUI's "trust
 *  project plugin config" command. Without it, a project-local plugin entry
 *  naming approve-for-me pauses auto-approval by design. Call it after the
 *  LAST write to the project config; the plugin re-reads the record on every
 *  request, so ordering relative to server start does not matter. */
export async function blessAutoApproveProjectConfig(
  stateHome: string,
  project: string,
) {
  const files: Record<string, string> = {}
  for (const candidate of worktreeConfigCandidates(project, project)) {
    try {
      files[candidate] = sha256Hex(await fs.readFile(candidate, "utf8"))
    } catch {
      // Missing candidate: nothing to bless.
    }
  }
  const record = blessFile(path.join(stateHome, "opencode"), project)
  await fs.mkdir(path.dirname(record), { recursive: true })
  await fs.writeFile(record, `${JSON.stringify({ files })}\n`)
  return record
}

/** The durable classifier-approvals journal, keyed like the plugin keys it. */
export function autoApproveJournalFile(stateDir: string, project: string) {
  return approvalsJournalFile(stateDir, project)
}

export function legacyAutoApproveSettingsFile(project: string) {
  return legacyProjectSettingsFile(project)
}

export async function writeAutoApproveSettings(
  configDir: string,
  project: string,
  settings: Record<string, unknown>,
) {
  const file = autoApproveSettingsFile(configDir, project)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
  return file
}

export async function writeStoreFile(
  configDir: string,
  project: string,
  store: Record<string, unknown>,
) {
  const file = storeFile(configDir, project)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`)
  return file
}
