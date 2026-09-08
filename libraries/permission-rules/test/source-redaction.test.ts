import { afterEach, describe, expect, test } from "bun:test"
import { redactSourceValue, registerSourceRedactor } from "../src/index"

const scope = {
  serverUrl: new URL("http://localhost:226"),
  directory: "/source-redaction-test",
}
const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})

function register(
  redact: (value: unknown) => void,
  target = scope,
): () => void {
  const release = registerSourceRedactor(target, redact)
  releases.push(release)
  return release
}

describe("optional source redaction", () => {
  test("late lookup preserves opt-out identity before registration and after release", () => {
    const source = { text: "original" }
    const consume = () => redactSourceValue(scope, source)
    expect(consume()).toBe(source)
    const release = register((value) => {
      ;(value as Array<typeof source>)[0]!.text = "masked"
    })
    expect(consume()).toEqual({ text: "masked" })
    release()
    expect(consume()).toBe(source)

    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(redactSourceValue(scope, cycle)).toBe(cycle)
    expect(redactSourceValue(scope, undefined)).toBeUndefined()
    expect(redactSourceValue(scope, 1n)).toBe(1n)
  })

  test("redacts only a detached JSON snapshot, evaluating toJSON once", () => {
    let serializations = 0
    const nested = Object.freeze({ text: "original" })
    const source = Object.freeze({
      nested,
      toJSON() {
        serializations++
        return { nested, omitted: undefined, fn: () => "ignored" }
      },
    })
    register((value) => {
      ;(value as Array<{ nested: { text: string } }>)[0]!.nested.text = "masked"
    })
    const result = redactSourceValue(scope, source)
    expect(result as unknown).toEqual({ nested: { text: "masked" } })
    expect(result).not.toBe(source)
    expect(result.nested).not.toBe(nested)
    expect(nested.text).toBe("original")
    expect(serializations).toBe(1)
    expect(JSON.stringify(result)).toBe('{"nested":{"text":"masked"}}')
    expect(serializations).toBe(1)
  })

  test("the mutable holder also supports root strings and JSON primitives", () => {
    register((value) => {
      const holder = value as unknown[]
      if (typeof holder[0] === "string") holder[0] = "masked"
    })
    expect(redactSourceValue(scope, "original")).toBe("masked")
    expect(redactSourceValue(scope, null)).toBeNull()
    expect(redactSourceValue(scope, 42)).toBe(42)
    expect(redactSourceValue(scope, false)).toBe(false)
  })

  test("servers and directories have independent registrations", () => {
    const otherDirectory = { ...scope, directory: `${scope.directory}/other` }
    const otherServer = {
      ...scope,
      serverUrl: new URL("http://localhost:227"),
    }
    register((value) => {
      ;(value as unknown[])[0] = "first"
    })
    const release = register((value) => {
      ;(value as unknown[])[0] = "second"
    }, otherDirectory)
    expect(redactSourceValue(scope, "source")).toBe("first")
    expect(redactSourceValue(otherDirectory, "source")).toBe("second")
    expect(redactSourceValue(otherServer, "source")).toBe("source")
    expect(
      redactSourceValue(
        { ...scope, serverUrl: "http://localhost:226" },
        "source",
      ),
    ).toBe("first")
    release()
    expect(redactSourceValue(otherDirectory, "source")).toBe("source")
    expect(redactSourceValue(scope, "source")).toBe("first")
  })

  test("old and repeated disposals cannot release a newer registration, even of the same callback", () => {
    const redact = (value: unknown) => {
      ;(value as unknown[])[0] = "masked"
    }
    const oldRelease = register(redact)
    const release = register(redact)
    oldRelease()
    oldRelease()
    expect(redactSourceValue(scope, "source")).toBe("masked")
    release()
    expect(redactSourceValue(scope, "source")).toBe("source")
    register(redact)
    release()
    expect(redactSourceValue(scope, "source")).toBe("masked")
  })

  test("serialization failures abort with only a constant sanitized error", () => {
    let calls = 0
    register(() => calls++)
    const cycle: Record<string, unknown> = { sensitive: "private source" }
    cycle.self = cycle
    for (const source of [
      cycle,
      1n,
      undefined,
      Symbol("private source"),
      () => "private source",
      { toJSON: () => undefined },
      {
        toJSON() {
          throw new Error("private source")
        },
      },
      {
        get text() {
          throw new Error("private source")
        },
      },
    ]) {
      let error: unknown
      try {
        redactSourceValue(scope, source)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Source redaction failed")
      expect((error as Error).cause).toBeUndefined()
      expect(String((error as Error).stack)).not.toContain("private source")
    }
    expect(calls).toBe(0)
  })

  test("redactor failures never return a partial snapshot or the raw source", () => {
    const source = { first: "original", second: "private source" }
    register((value) => {
      ;(value as Array<typeof source>)[0]!.first = "masked"
      throw new Error("private source")
    })
    expect(() => redactSourceValue(scope, source)).toThrow(
      /^Source redaction failed$/,
    )
    expect(source).toEqual({ first: "original", second: "private source" })
  })

  test("independently bundled module copies share registration at call time", async () => {
    const build = await Bun.build({
      entrypoints: [
        new URL("../src/source-redaction.ts", import.meta.url).pathname,
      ],
      target: "bun",
    })
    expect(build.success).toBe(true)
    const code = await build.outputs[0]!.text()
    const consumerCode = Buffer.from(`${code}\n// consumer`).toString("base64")
    const producerCode = Buffer.from(`${code}\n// producer`).toString("base64")
    const consumer = await import(`data:text/javascript;base64,${consumerCode}`)
    const producer = await import(`data:text/javascript;base64,${producerCode}`)
    expect(consumer.registerSourceRedactor).not.toBe(
      producer.registerSourceRedactor,
    )
    expect(consumer.redactSourceValue(scope, "source")).toBe("source")
    const release = producer.registerSourceRedactor(scope, (value: unknown) => {
      ;(value as unknown[])[0] = "masked"
    })
    releases.push(release)
    expect(consumer.redactSourceValue(scope, "source")).toBe("masked")
    expect(redactSourceValue(scope, "source")).toBe("masked")
    release()
    expect(consumer.redactSourceValue(scope, "source")).toBe("source")
  })
})
