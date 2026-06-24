import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ProviderService } from "./provider";
import type { Transformer, TransformerConstructor } from "@/types/transformer";

// Minimal stubs — ProviderService only needs get() and a logger sink.
function makeConfig(providers: any[] = []) {
  return {
    get: (_key: string) => providers,
  } as any;
}
const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

// A fake transformer class mirroring how real transformers are constructed:
// `new Constructor(options)` produces an instance with transform methods.
class FakeTransformerClass {
  options: any;
  endPoint = "fake-endpoint";
  constructor(options?: any) {
    this.options = options;
  }
  transformRequestOut = async () => ({}) as any;
}
const fakeTransformerInstance: Transformer = {
  endPoint: "fake-instance-endpoint",
  transformRequestOut: async () => ({}) as any,
};

function makeTransformerService(map: Record<string, any>) {
  return {
    getTransformer: (name: string) => map[name],
    registerTransformer: () => {},
  } as any;
}

describe("ProviderService.registerProvider — transformer resolution (B1)", () => {
  test("resolves a [ConstructorName, options] array into a constructed instance", () => {
    const svc = new ProviderService(
      makeConfig([]),
      makeTransformerService({ maxtoken: FakeTransformerClass }),
      silentLogger
    );

    svc.registerProvider({
      name: "p1",
      baseUrl: "http://x",
      apiKey: "k",
      models: ["m"],
      transformer: { use: [["maxtoken", { max_tokens: 8192 }]] },
    } as any);

    const provider = svc.getProvider("p1")!;
    assert.ok(provider.transformer, "transformer must be set");
    const resolved = provider.transformer!.use![0];
    assert.ok(resolved instanceof FakeTransformerClass, "must be a constructed instance, not the raw array");
    assert.equal((resolved as any).options.max_tokens, 8192, "options must be forwarded to constructor");
  });

  test("resolves a bare string into an instance when getTransformer returns a constructor function", () => {
    const svc = new ProviderService(
      makeConfig([]),
      makeTransformerService({ tooluse: FakeTransformerClass }),
      silentLogger
    );

    svc.registerProvider({
      name: "p2",
      baseUrl: "http://x",
      apiKey: "k",
      models: ["m"],
      transformer: { use: ["tooluse"] },
    } as any);

    const resolved = svc.getProvider("p2")!.transformer!.use![0];
    assert.ok(resolved instanceof FakeTransformerClass, "bare string must resolve to constructed instance");
  });

  test("resolves a bare string into the instance when getTransformer returns an object", () => {
    const svc = new ProviderService(
      makeConfig([]),
      makeTransformerService({ gemini: fakeTransformerInstance }),
      silentLogger
    );

    svc.registerProvider({
      name: "p3",
      baseUrl: "http://x",
      apiKey: "k",
      models: ["m"],
      transformer: { use: ["gemini"] },
    } as any);

    const resolved = svc.getProvider("p3")!.transformer!.use![0];
    assert.equal(resolved, fakeTransformerInstance, "must be the registered instance itself");
  });

  test("resolves model-scoped transformer { [model]: { use: [...] } }", () => {
    const svc = new ProviderService(
      makeConfig([]),
      makeTransformerService({ maxtoken: FakeTransformerClass }),
      silentLogger
    );

    svc.registerProvider({
      name: "p4",
      baseUrl: "http://x",
      apiKey: "k",
      models: ["m"],
      transformer: { m: { use: [["maxtoken", { max_tokens: 4096 }]] } },
    } as any);

    const resolved = svc.getProvider("p4")!.transformer!.m!.use![0];
    assert.ok(resolved instanceof FakeTransformerClass, "model-scoped transformer must be resolved");
    assert.equal((resolved as any).options.max_tokens, 4096);
  });
});
