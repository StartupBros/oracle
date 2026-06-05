import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectChatGptFileArtifacts,
  readAssistantDownloadableFiles,
  saveChatGptDownloadableFiles,
  __test__,
} from "../../src/browser/chatgptFiles.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("readAssistantDownloadableFiles", () => {
  test("keeps ChatGPT file downloads and sandbox references but rejects external links", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://evil.example/archive.zip",
              filename: "archive.zip",
            },
            {
              url: "https://chatgpt.com/backend-api/files/file_package/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
              sandboxUrl: "sandbox:/mnt/data/package.zip",
              filename: "package.zip",
              label: "package.zip",
            },
            {
              url: "sandbox:/mnt/data/source.tar.gz",
              sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
              filename: "source.tar.gz",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const files = await readAssistantDownloadableFiles(runtime);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/files/file_package/download",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(files[1]).toMatchObject({
      url: "sandbox:/mnt/data/source.tar.gz",
      sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
      filename: "source.tar.gz",
    });
  });
});

describe("saveChatGptDownloadableFiles", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("saves ChatGPT downloadable files as session artifacts with cookies", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-files-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_package/download?token=ok",
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/zip";
          if (name === "content-disposition") return 'attachment; filename="package.zip"';
          return null;
        },
      },
      arrayBuffer: async () => Uint8Array.from([9, 8, 7]).buffer,
    } as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_package/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
          sandboxUrl: "sandbox:/mnt/data/package.zip",
          filename: "ignored.bin",
          label: "package.zip",
        },
      ],
    });

    expect(result.saved).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      label: "package.zip",
      mimeType: "application/zip",
      sourceUrl: "sandbox:/mnt/data/package.zip",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "file-session", "artifacts", "package.zip"),
    );
    await expect(fs.readFile(result.savedFiles[0]!.path)).resolves.toEqual(Buffer.from([9, 8, 7]));
  });

  test("does not fetch sandbox-only references", async () => {
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "sandbox:/mnt/data/source.tar.gz",
          sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
          filename: "source.tar.gz",
        },
      ],
    });

    expect(result.saved).toBe(false);
    expect(result.fileCount).toBe(1);
    expect(result.errors[0]).toContain("no ChatGPT download URL found");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("collectChatGptFileArtifacts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("discovers and saves downloadable file artifacts for a browser session", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-collect-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/files/file_wheel/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_wheel/download",
              sandboxUrl: "sandbox:/mnt/data/pkg.whl",
              filename: "pkg.whl",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_wheel/download",
      headers: {
        get: (name: string) => (name === "content-type" ? "application/octet-stream" : null),
      },
      arrayBuffer: async () => Uint8Array.from([1, 3, 5]).buffer,
    } as Response);

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "collect-session", "artifacts", "pkg.whl"),
    );
  });

  test("normalizes only ChatGPT backend file URLs", () => {
    expect(__test__.normalizeChatGptDownloadUrl("https://example.com/file_1.zip")).toBeUndefined();
    expect(__test__.normalizeChatGptDownloadUrl("sandbox:/mnt/data/file.zip")).toBeUndefined();
    expect(__test__.normalizeSandboxUrl("sandbox:/mnt/data/file.zip")).toBe(
      "sandbox:/mnt/data/file.zip",
    );
  });
});
