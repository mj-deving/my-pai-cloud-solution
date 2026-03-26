import { describe, test, expect, mock, beforeEach } from "bun:test";
import { A2AClient } from "../a2a-client";
import type { Config } from "../config";

const mockConfig = {} as unknown as Config;

const sampleCard = {
  name: "TestAgent",
  description: "A test agent",
  url: "http://localhost:9000",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  skills: [{ id: "echo", name: "Echo", description: "Echoes input" }],
  authentication: { schemes: ["bearer"] },
};

describe("A2AClient", () => {
  let client: A2AClient;

  beforeEach(() => {
    client = new A2AClient(mockConfig);
  });

  test("discover() fetches and caches an agent card", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(sampleCard), { status: 200 })),
    ) as any;

    const card = await client.discover("http://localhost:9000");
    expect(card).not.toBeNull();
    expect(card!.name).toBe("TestAgent");
    expect(client.getDiscoveredAgents().size).toBe(1);

    globalThis.fetch = originalFetch;
  });

  test("discover() returns null on fetch failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as any;

    const card = await client.discover("http://localhost:9000");
    expect(card).toBeNull();

    globalThis.fetch = originalFetch;
  });

  test("send() returns success with text result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: {
              id: "task-1",
              artifacts: [{ parts: [{ type: "text", text: "Hello back" }] }],
            },
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const r = await client.send("http://localhost:9000", "Hello", {
      token: "tok",
    });
    expect(r.success).toBe(true);
    expect(r.result).toBe("Hello back");
    expect(r.taskId).toBe("task-1");

    globalThis.fetch = originalFetch;
  });

  test("send() handles HTTP errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as any;

    const r = await client.send("http://localhost:9000", "Hello");
    expect(r.success).toBe(false);
    expect(r.error).toContain("500");

    globalThis.fetch = originalFetch;
  });

  test("send() handles network errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as any;

    const r = await client.send("http://localhost:9000", "Hello");
    expect(r.success).toBe(false);
    expect(r.error).toContain("Connection refused");

    globalThis.fetch = originalFetch;
  });

  test("getDiscoveredAgents() returns empty map initially", () => {
    expect(client.getDiscoveredAgents().size).toBe(0);
  });

  test("getStats() returns correct count", async () => {
    expect(client.getStats().discoveredAgents).toBe(0);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(sampleCard), { status: 200 })),
    ) as any;

    await client.discover("http://localhost:9000");
    expect(client.getStats().discoveredAgents).toBe(1);

    globalThis.fetch = originalFetch;
  });
});
