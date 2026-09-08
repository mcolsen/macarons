import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"
import { permissionStoreFile } from "../src/shared"

// The one install method that cannot follow the ./shared import is copying a
// file into `.opencode/plugin/`; the artifact must stand alone. The harness
// realpaths its temp dir, which this plugin's end-to-end case depends on: the
// plugin hashes the canonical project root, and the store path read at the
// end would otherwise name a different file.

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "PersistPermissionsPlugin",
})

describe("bundled behavior", () => {
  test("persists an always-approval end to end", async () => {
    const mod = (await bundle.importArtifact()) as unknown as {
      PersistPermissionsPlugin: (
        input: unknown,
      ) => Promise<{ event: (input: unknown) => Promise<void> }>
    }
    const dir = path.dirname(bundle.artifact())
    const root = path.join(dir, "project")
    const configDir = path.join(dir, "config")
    const stateDir = path.join(dir, "state")
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(configDir),
      fs.mkdir(stateDir),
    ])
    class App {
      _client = {}
      log() {
        void this._client
        return Promise.resolve({ data: true })
      }
    }
    class Client {
      _client = {}
      app = new App()
      global = {
        health: () =>
          Promise.resolve({ data: { healthy: true, version: BAND.floor } }),
      }
      path = {
        get: () =>
          Promise.resolve({ data: { config: configDir, state: stateDir } }),
      }
      postSessionIdPermissionsPermissionId() {
        void this._client
        return Promise.resolve({ data: true })
      }
    }
    const hooks = await mod.PersistPermissionsPlugin({
      client: new Client(),
      directory: root,
      worktree: root,
      project: {},
      serverUrl: new URL("http://localhost:4096"),
      experimental_workspace: { register() {} },
      $: {},
    })
    const properties = {
      id: "per_bundle",
      sessionID: "ses_bundle",
      permission: "bash",
      patterns: ["git status"],
      always: ["git status *"],
    }
    await hooks.event({ event: { type: "permission.asked", properties } })
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { requestID: "per_bundle", reply: "always" },
      },
    })
    const store = JSON.parse(
      await fs.readFile(permissionStoreFile(configDir, root), "utf8"),
    )
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
  })
})
