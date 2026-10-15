import { expect, test } from "bun:test"
import { fixture, pluginURL, prompt } from "./fixture"

test("loads native package-directory plugin and applies scoped prompts on a real v2 host", async () => {
  const host = await fixture({
    plugins: [
      {
        package: pluginURL("scoped-system-prompts"),
        options: {
          prompts: [
            {
              model: "fixture/model",
              mode: "append",
              content: "MACARONS_V2_SCOPE",
            },
          ],
        },
      },
    ],
  })
  try {
    expect(
      host.ready.data.some(
        (plugin) =>
          plugin.id === "scoped-system-prompts" &&
          plugin.state.status === "active",
      ),
    ).toBe(true)
    await prompt(host, "Hello")
    expect(
      host.provider.requests.some((request) =>
        JSON.stringify(request.messages).includes("MACARONS_V2_SCOPE"),
      ),
    ).toBe(true)
  } finally {
    await host.dispose()
  }
})

test("all retained server plugins load together without retired tools", async () => {
  const { SERVER_PLUGINS } = await import("./fixture")
  const host = await fixture({
    plugins: SERVER_PLUGINS.map((name) => ({
      package: pluginURL(name),
      options: name === "web-search" ? { native: { enabled: false } } : {},
    })),
  })
  try {
    const installed = host.ready.data.filter(
      (plugin) => plugin.source.type !== "builtin",
    )
    expect(installed).toHaveLength(7)
    expect(installed.every((plugin) => plugin.state.status === "active")).toBe(
      true,
    )
    await prompt(host, "Show the available tools")
    const tools = JSON.stringify(
      host.provider.requests.flatMap((request) => request.tools ?? []),
    )
    expect(tools).toContain("cron_create")
    expect(tools).not.toContain("background_task")
    expect(tools).not.toContain("subagent_spawn")
  } finally {
    await host.dispose()
  }
})

test("redacts a secret on the real provider wire and leaves stored source local", async () => {
  const secret = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"
  const host = await fixture({ plugins: [pluginURL("redact-secrets")] })
  try {
    const session = await prompt(
      host,
      `Review this test fixture token: ${secret}`,
    )
    const wire = JSON.stringify(host.provider.requests)
    expect(wire).not.toContain(secret)
    expect(wire).toContain("REDACTED")
    const context = await host.client.session.context({ sessionID: session.id })
    expect(
      context.some(
        (message) => message.type === "user" && message.text.includes(secret),
      ),
    ).toBe(true)
  } finally {
    await host.dispose()
  }
})

test("SearXNG extends the native provider catalog and returns native results", async () => {
  const search = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).searchParams.get("q")).toBe("migration")
      return Response.json({
        results: [
          {
            url: "https://example.test/v2",
            title: "V2",
            content: "Native result",
          },
        ],
      })
    },
  })
  const host = await fixture({
    plugins: [
      {
        package: pluginURL("web-search"),
        options: {
          searxng: { url: search.url.origin },
          native: { enabled: false },
        },
      },
    ],
  })
  try {
    const location = { directory: host.sandbox.project }
    const catalog = await host.client.websearch.providers({ location })
    expect(
      catalog.data.some((provider) => provider.id === "macarons-searxng"),
    ).toBe(true)
    expect(catalog.data.some((provider) => provider.id === "exa")).toBe(true)
    const results = await host.client.websearch.query({
      query: "migration",
      providerID: "macarons-searxng",
      location,
    })
    expect(results.data.results).toEqual([
      {
        url: "https://example.test/v2",
        title: "V2",
        content: "Native result",
        time: {},
      },
    ])
  } finally {
    await host.dispose()
    search.stop(true)
  }
})

test("cron native tool asks permission before creating a schedule", async () => {
  const { waitFor } = await import("../harness/wait")
  const host = await fixture({
    plugins: [pluginURL("cron")],
    config: {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "cron", resource: "*", effect: "ask" },
      ],
    },
    respond(context) {
      if (context.hasToolResultAfterLastUser())
        return { kind: "text", text: "schedule handled" }
      return {
        kind: "tool_call",
        name: "cron_create",
        args: {
          cron: "0 0 1 1 *",
          prompt: "MACARONS_SCHEDULED_PROMPT",
          recurring: false,
        },
      }
    },
  })
  try {
    const session = await host.client.session.create({
      location: { directory: host.sandbox.project },
    })
    await host.client.session.prompt({
      sessionID: session.id,
      text: "Create a reminder",
    })
    let requestID = ""
    await waitFor(
      async () => {
        const requests = await host.client.permission.list({
          sessionID: session.id,
        })
        const request = requests.find((request) => request.action === "cron")
        if (!request) return false
        expect(request.resources).toEqual(["MACARONS_SCHEDULED_PROMPT"])
        requestID = request.id
        return true
      },
      { description: "native cron permission" },
    )
    await host.client.permission.reply({
      sessionID: session.id,
      requestID,
      decision: "once",
    })
    await waitFor(
      async () =>
        JSON.stringify(
          await host.client.session.context({ sessionID: session.id }),
        ).includes("Created cron job"),
      { description: "cron tool result" },
    )
  } finally {
    await host.dispose()
  }
})

test("Approve for Me reviews a real native shell permission using an isolated judge", async () => {
  const host = await fixture({
    plugins: [
      {
        package: pluginURL("approve-for-me"),
        options: {
          notify: false,
          journal: false,
          sweepStale: false,
          unattendedDenyMs: 0,
        },
      },
    ],
    config: {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    },
    respond(context) {
      if (
        JSON.stringify(context.request.messages).includes(
          "You are a permission gatekeeper",
        )
      )
        return {
          kind: "text",
          text: JSON.stringify({
            decision: "approve",
            risk: "low",
            authorization: "implied",
            reason: "Test-only harmless printf",
          }),
        }
      if (context.hasToolResultAfterLastUser())
        return { kind: "text", text: "approved command completed" }
      return {
        kind: "tool_call",
        name: "shell",
        args: {
          command: "printf MACARONS_APPROVED",
          description: "Print test marker",
        },
      }
    },
  })
  try {
    const session = await prompt(host, "Print a marker")
    const context = await host.client.session.context({ sessionID: session.id })
    expect(JSON.stringify(context)).toContain("MACARONS_APPROVED")
    const judge = host.provider.requests.find((request) =>
      JSON.stringify(request.messages).includes(
        "You are a permission gatekeeper",
      ),
    )
    expect(judge).toBeDefined()
    expect(judge?.tools ?? []).toHaveLength(0)
    expect(
      await host.client.permission.list({ sessionID: session.id }),
    ).toHaveLength(0)
  } finally {
    await host.dispose()
  }
})

test("redaction restores tool arguments locally and remasks tool results on the next request", async () => {
  const secret = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"
  const host = await fixture({
    plugins: [
      pluginURL("redact-secrets"),
      new URL("./fixtures/restore/", import.meta.url).href,
    ],
    respond(context) {
      if (context.hasToolResultAfterLastUser())
        return { kind: "text", text: "restoration complete" }
      const placeholder = JSON.stringify(context.request.messages).match(
        /\[REDACTED-SECRET:[a-z0-9-]+:[a-f0-9]{16}\]/,
      )?.[0]
      if (!placeholder) throw new Error("Fixture received an unredacted token")
      return {
        kind: "tool_call",
        name: "capture_token",
        args: { token: placeholder },
      }
    },
  })
  try {
    const session = await prompt(
      host,
      `Pass this test token to capture_token: ${secret}`,
    )
    await host.client.session.wait({ sessionID: session.id })
    const messages = await host.client.session.context({
      sessionID: session.id,
    })
    const output = messages
      .flatMap((message) =>
        message.type === "assistant" ? message.content : [],
      )
      .find((part) => part.type === "tool" && part.name === "capture_token")
    expect(
      output?.type === "tool" &&
        output.state.status === "completed" &&
        JSON.stringify(output.state.content).includes(secret),
    ).toBe(true)
    expect(JSON.stringify(host.provider.requests)).not.toContain(secret)
    expect(host.provider.requests.length).toBeGreaterThanOrEqual(2)
  } finally {
    await host.dispose()
  }
})

test("redacted tool names keep their native executor through provider-safe aliases", async () => {
  const secret = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"
  const host = await fixture({
    plugins: [
      new URL("./fixtures/redaction-tool", import.meta.url).href,
      pluginURL("redact-secrets"),
    ],
    respond(context) {
      if (context.hasToolResultAfterLastUser())
        return { kind: "text", text: "alias completed" }
      const name = context.request.tools
        ?.map(
          (tool) => (tool as { function?: { name?: string } }).function?.name,
        )
        .find((name) => name?.startsWith("macarons_redacted_"))
      if (!name) return { kind: "text", text: "no alias advertised" }
      return { kind: "tool_call", name, args: {} }
    },
  })
  try {
    const session = await prompt(host, "Call the fixed-marker tool")
    const messages = await host.client.session.context({
      sessionID: session.id,
    })
    expect(JSON.stringify(messages)).toContain("MACARONS_ALIAS_EXECUTED")
    expect(JSON.stringify(host.provider.requests)).not.toContain(secret)
    const names = host.provider.requests
      .flatMap((request) => request.tools ?? [])
      .map((tool) => (tool as { function?: { name?: string } }).function?.name)
      .filter((name) => name?.startsWith("macarons_redacted_"))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  } finally {
    await host.dispose()
  }
})
