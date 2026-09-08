import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"

// The harness runs the package's own `build` script from the package root —
// exactly the way `bun run build` (and README Option C) does — so
// dependencies bun did not hoist to the monorepo root (jsonc-parser) resolve
// through the package's own node_modules instead of bun's install cache.

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "ApproveForMePlugin",
})

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("bundled behavior", () => {
  test.each([
    { name: "the bundle itself", approves: true },
    {
      name: "a copied bundle with no package manifest",
      copied: true,
      approves: true,
    },
    {
      name: "a copied bundle with an unrelated package manifest",
      copied: true,
      manifest: { name: "@macarons/unrelated-plugin" },
      approves: true,
    },
    {
      name: "an explicitly configured copied bundle",
      copied: true,
      disablesArtifact: true,
      approves: false,
    },
  ])("uses only its own configuration with $name", async (fixture) => {
    type BundleHooks = {
      event: (input: unknown) => Promise<void>
      "experimental.chat.system.transform"?: (
        input: { sessionID?: string; model: unknown },
        output: { system: string[] },
      ) => Promise<void>
    }
    const dir = path.join(
      path.dirname(bundle.artifact()),
      fixture.name.replaceAll(" ", "-"),
    )
    const root = path.join(dir, "project")
    const config = path.join(dir, "config")
    let artifact = bundle.artifact()
    let foreign: string | undefined
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(path.join(dir, "state"), { recursive: true }),
      fs.mkdir(config, { recursive: true }),
    ])
    if (fixture.copied) {
      artifact = path.join(dir, ".opencode", "plugin", "approve-for-me.js")
      foreign = path.join(dir, ".opencode", "unrelated-plugin.js")
      await fs.mkdir(path.dirname(artifact), { recursive: true })
      await Promise.all([
        fs.copyFile(bundle.artifact(), artifact),
        fs.writeFile(foreign, "export default () => {}\n"),
        ...(fixture.manifest
          ? [
              fs.writeFile(
                path.join(dir, "package.json"),
                `${JSON.stringify(fixture.manifest)}\n`,
              ),
            ]
          : []),
      ])
    }
    await fs.writeFile(
      path.join(config, "opencode.json"),
      `${JSON.stringify({
        plugin: [
          ["@macarons/approve-for-me", { model: "e2e/test" }],
          ...(foreign
            ? [[pathToFileURL(foreign).href, { enabled: false }]]
            : []),
          ...(fixture.disablesArtifact
            ? [[pathToFileURL(artifact).href, { enabled: false }]]
            : []),
        ],
      })}\n`,
    )
    const mod = (await import(pathToFileURL(artifact).href)) as unknown as {
      ApproveForMePlugin: (input: unknown) => Promise<BundleHooks>
    }
    let hooks: BundleHooks
    let classifierSessions = 0
    let classifierSystem: string[] = []

    globalThis.fetch = (async (
      input: any,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input))
      if (init?.method === "POST" && url.pathname === "/session") {
        classifierSessions++
        return Response.json({ id: "ses_classifier" })
      }
      if (
        init?.method === "POST" &&
        url.pathname === "/session/ses_classifier/message"
      ) {
        classifierSystem = ["inherited project instructions"]
        await hooks["experimental.chat.system.transform"]?.(
          { sessionID: "ses_classifier", model: {} },
          { system: classifierSystem },
        )
        return Response.json({
          info: {
            structured: {
              decision: "approve",
              risk: "low",
              authorization: "implied",
              reason: "read-only",
            },
          },
          parts: [],
        })
      }
      return Response.json(true)
    }) as typeof fetch

    const replies: any[] = []
    class App {
      _client = {}
      log() {
        void this._client
        return Promise.resolve({ data: true })
      }
      agents() {
        void this._client
        return Promise.resolve({
          data: [
            {
              name: "build",
              permission: [
                { permission: "*", pattern: "*", action: "allow" },
                { permission: "bash", pattern: "*", action: "ask" },
              ],
            },
          ],
        })
      }
    }
    class Client {
      _client = {}
      app = new App()
      config = {
        get: () =>
          Promise.resolve({
            data: { permission: { bash: "ask" }, model: "e2e/test" },
          }),
        providers: () =>
          Promise.resolve({
            data: {
              providers: [{ id: "e2e", models: { test: {} } }],
              default: {},
            },
          }),
      }
      path = {
        get: () =>
          Promise.resolve({
            data: { state: path.join(dir, "state"), config },
          }),
      }
      session = {
        get: () => Promise.resolve({ data: { id: "ses_1" } }),
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "user", agent: "build" },
                parts: [{ type: "text", text: "Check the working tree" }],
              },
            ],
          }),
      }
      tui = { showToast: () => Promise.resolve({ data: true }) }
      global = {
        health: () =>
          Promise.resolve({ data: { healthy: true, version: BAND.floor } }),
      }
      postSessionIdPermissionsPermissionId(options: any) {
        void this._client
        replies.push(options)
        return Promise.resolve({ data: true })
      }
    }
    hooks = await mod.ApproveForMePlugin({
      client: new Client(),
      directory: root,
      worktree: root,
      project: {},
      serverUrl: new URL("http://127.0.0.1:14096"),
      experimental_workspace: { register() {} },
      $: {},
    })
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_bundle",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["git status"],
          always: ["git status *"],
          metadata: {},
        },
      },
    })
    if (!fixture.approves) {
      expect(replies).toHaveLength(0)
      expect(classifierSessions).toBe(0)
      expect(classifierSystem).toHaveLength(0)
      return
    }
    expect(classifierSessions).toBe(1)
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toEqual({ response: "once" })
    expect(classifierSystem).toHaveLength(1)
    expect(classifierSystem[0]).toContain("permission gatekeeper")
    expect(classifierSystem[0]).not.toContain("inherited project instructions")
  })
})
