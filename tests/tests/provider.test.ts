import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, streamChat } from "../server/provider.js";
import { makeModel } from "./fixtures.js";

describe("OpenAI-compatible provider", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeEach(async () => {
    process.env.TEST_PROVIDER_KEY = "test-key";
    server = http.createServer((request, response) => {
      if (request.url === "/rate-limit/chat/completions") {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"model":"mock","choices":[{"delta":{"content":"你"}}]}\n\n');
      response.write('data: {"model":"mock","choices":[{"delta":{"content":"好"}}]}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"cost":0.001}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    delete process.env.TEST_PROVIDER_KEY;
  });

  it("normalizes streamed text and final usage", async () => {
    const chunks = [];
    for await (const chunk of streamChat(makeModel({ baseUrl }), {
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 20,
      temperature: 0.5,
      signal: new AbortController().signal,
      timeoutMs: 2_000
    })) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.content ?? "").join("")).toBe("你好");
    expect(chunks.at(-1)?.usage).toMatchObject({ totalTokens: 5, cost: 0.001, estimated: false });
  });

  it("preserves an upstream 429 as a typed provider error", async () => {
    const consume = async () => {
      for await (const _chunk of streamChat(makeModel({ baseUrl: `${baseUrl}/rate-limit` }), {
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 20,
        temperature: 0.5,
        signal: new AbortController().signal,
        timeoutMs: 2_000
      })) {
        // Consume the generator.
      }
    };
    await expect(consume()).rejects.toMatchObject({ status: 429 } satisfies Partial<ProviderError>);
  });
});
