import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix directory", () => {
  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };

  beforeEach(() => {
    setMatrixRuntime({
      state: {
        resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
      },
    } as PluginRuntime);
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        "matrix-js": {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.directory).toBeTruthy();
    expect(matrixPlugin.directory?.listPeers).toBeTruthy();
    expect(matrixPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      matrixPlugin.directory!.listPeers!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:@alice:example.org" },
        { kind: "user", id: "bob", name: "incomplete id; expected @user:server" },
        { kind: "user", id: "user:@carol:example.org" },
        { kind: "user", id: "user:@dana:example.org" },
      ]),
    );

    await expect(
      matrixPlugin.directory!.listGroups!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });

  it("resolves replyToMode from account config", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          replyToMode: "off",
          accounts: {
            Assistant: {
              replyToMode: "all",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.threading?.resolveReplyToMode).toBeTruthy();
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "assistant",
        chatType: "direct",
      }),
    ).toBe("all");
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "default",
        chatType: "direct",
      }),
    ).toBe("off");
  });

  it("resolves group mention policy from account config", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          groups: {
            "!room:example.org": { requireMention: true },
          },
          accounts: {
            Assistant: {
              groups: {
                "!room:example.org": { requireMention: false },
              },
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.groups!.resolveRequireMention!({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "!room:example.org",
      }),
    ).toBe(false);
  });

  it("writes matrix-js non-default account credentials under channels.matrix-js.accounts", () => {
    const cfg = {
      channels: {
        "matrix-js": {
          homeserver: "https://default.example.org",
          accessToken: "default-token",
        },
      },
    } as unknown as CoreConfig;

    const updated = matrixPlugin.setup!.applyAccountConfig({
      cfg,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
    }) as CoreConfig;

    expect(updated.channels?.["matrix-js"]?.accessToken).toBe("default-token");
    expect(updated.channels?.["matrix-js"]?.accounts?.ops).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
  });

  it("rejects useEnv for non-default matrix-js accounts", () => {
    const error = matrixPlugin.setup!.validateInput?.({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: { useEnv: true },
    });
    expect(error).toBe("MATRIX_* env vars can only be used for the default account.");
  });
});
