import path from "node:path";
import type {
  BrowserDownloadableFile,
  BrowserLogger,
  ChromeClient,
  SavedBrowserFile,
} from "./types.js";
import { ASSISTANT_ROLE_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { writeBinaryBrowserArtifact } from "./artifacts.js";

const CHATGPT_DOWNLOAD_BASE_URL = "https://chatgpt.com/";

function isAllowedChatGptHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "chatgpt.com" || value.endsWith(".chatgpt.com") || value === "chat.openai.com";
}

function normalizeChatGptDownloadUrl(value?: string | null): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("sandbox:") || raw.startsWith("blob:")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw, CHATGPT_DOWNLOAD_BASE_URL);
  } catch {
    return undefined;
  }
  if (!isAllowedChatGptHost(url.hostname)) {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const pathName = url.pathname.toLowerCase();
  if (!pathName.includes("/backend-api/")) {
    return undefined;
  }
  return url.href;
}

function normalizeSandboxUrl(value?: string | null): string | undefined {
  const raw = String(value ?? "").trim();
  return raw.startsWith("sandbox:/mnt/data/") ? raw : undefined;
}

function dedupeFiles(files: BrowserDownloadableFile[]): BrowserDownloadableFile[] {
  const deduped = new Map<string, BrowserDownloadableFile>();
  for (const file of files) {
    const key = file.downloadUrl ?? file.sandboxUrl ?? file.url;
    if (!deduped.has(key)) {
      deduped.set(key, file);
    }
  }
  return [...deduped.values()];
}

function buildAssistantDownloadableFilesExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const isChatGptDownloadUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('sandbox:') || raw.startsWith('blob:')) return false;
      try {
        const url = new URL(raw, location.origin || 'https://chatgpt.com');
        const host = url.hostname.toLowerCase();
        const allowedHost = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
        return allowedHost && url.pathname.toLowerCase().includes('/backend-api/');
      } catch {
        return raw.startsWith('/backend-api/');
      }
    };
    const isSandboxUrl = (value) => String(value || '').trim().startsWith('sandbox:/mnt/data/');
    const basename = (value) => {
      const raw = String(value || '').split(/[?#]/)[0].replace(/\\/+$/g, '');
      const part = raw.slice(raw.lastIndexOf('/') + 1);
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const serializeAnchor = (anchor) => {
      const hrefAttr = anchor.getAttribute('href') || '';
      const values = [hrefAttr, anchor.href || ''];
      for (const attribute of Array.from(anchor.attributes || [])) {
        values.push(String(attribute.value || ''));
      }
      const downloadUrl = values.find(isChatGptDownloadUrl) || '';
      const sandboxUrl = values.find(isSandboxUrl) || '';
      if (!downloadUrl && !sandboxUrl) return null;
      const label = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim();
      const filename =
        anchor.getAttribute('download') ||
        basename(sandboxUrl) ||
        basename(downloadUrl) ||
        label ||
        '';
      return {
        url: downloadUrl || sandboxUrl || hrefAttr || anchor.href || '',
        downloadUrl,
        sandboxUrl,
        filename,
        label,
        mimeType: anchor.getAttribute('type') || '',
      };
    };
    const serializeFiles = (root) =>
      Array.from(root.querySelectorAll('a[href], a[download]'))
        .map(serializeAnchor)
        .filter(Boolean);
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) continue;
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) || turn;
      const files = serializeFiles(messageRoot);
      if (files.length > 0) return files;
    }
    return [];
  })()`;
}

export async function readAssistantDownloadableFiles(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<BrowserDownloadableFile[]> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantDownloadableFilesExpression(minTurnIndex),
    returnByValue: true,
  });
  const raw = Array.isArray(result?.value) ? result.value : [];
  const normalized: BrowserDownloadableFile[] = [];
  for (const item of raw) {
    const downloadUrl = normalizeChatGptDownloadUrl(
      typeof item?.downloadUrl === "string" ? item.downloadUrl : item?.url,
    );
    const sandboxUrl = normalizeSandboxUrl(
      typeof item?.sandboxUrl === "string" ? item.sandboxUrl : item?.url,
    );
    if (!downloadUrl && !sandboxUrl) {
      continue;
    }
    normalized.push({
      url: downloadUrl ?? sandboxUrl ?? "",
      downloadUrl,
      sandboxUrl,
      filename: typeof item?.filename === "string" ? item.filename : undefined,
      label: typeof item?.label === "string" ? item.label : undefined,
      mimeType: typeof item?.mimeType === "string" ? item.mimeType : undefined,
    });
  }
  return dedupeFiles(normalized);
}

async function buildCookieHeader(Network: ChromeClient["Network"]): Promise<string> {
  const response = await Network.getCookies({ urls: ["https://chatgpt.com/"] });
  return (response.cookies ?? [])
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  const header = String(value ?? "");
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ""));
    } catch {
      return encoded.trim().replace(/^"|"$/g, "");
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

function filenameFromUrl(value?: string): string | undefined {
  const raw = String(value ?? "")
    .split(/[?#]/)[0]
    .replace(/\/+$/g, "");
  if (!raw) return undefined;
  const part = raw.slice(raw.lastIndexOf("/") + 1);
  if (!part) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function fallbackExtensionFromContentType(contentType?: string | null): string {
  const value = String(contentType ?? "").toLowerCase();
  if (value.includes("zip")) return "zip";
  if (value.includes("json")) return "json";
  if (value.includes("csv")) return "csv";
  if (value.includes("markdown")) return "md";
  if (value.includes("html")) return "html";
  if (value.includes("pdf")) return "pdf";
  if (value.startsWith("text/")) return "txt";
  return "bin";
}

function resolveDownloadedFilename(params: {
  file: BrowserDownloadableFile;
  contentDisposition: string | null;
  contentType: string | null;
  index: number;
}): string {
  const filename =
    filenameFromContentDisposition(params.contentDisposition) ??
    params.file.filename ??
    filenameFromUrl(params.file.sandboxUrl) ??
    filenameFromUrl(params.file.downloadUrl) ??
    filenameFromUrl(params.file.url);
  if (filename && path.extname(filename)) {
    return filename;
  }
  const fallback = filename || `chatgpt-file-${params.index + 1}`;
  return `${fallback}.${fallbackExtensionFromContentType(params.contentType)}`;
}

export async function saveChatGptDownloadableFiles(params: {
  Network: ChromeClient["Network"];
  files: BrowserDownloadableFile[];
  sessionId?: string;
  logger?: BrowserLogger;
}): Promise<{
  saved: boolean;
  fileCount: number;
  savedFiles: SavedBrowserFile[];
  errors: string[];
}> {
  const { Network, files, sessionId, logger } = params;
  if (!files.length) {
    return { saved: false, fileCount: 0, savedFiles: [], errors: [] };
  }

  const cookieHeader = await buildCookieHeader(Network);
  if (!cookieHeader) {
    return {
      saved: false,
      fileCount: files.length,
      savedFiles: [],
      errors: ["Missing ChatGPT cookies for file download."],
    };
  }

  const savedFiles: SavedBrowserFile[] = [];
  const errors: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const downloadUrl = normalizeChatGptDownloadUrl(file.downloadUrl ?? file.url);
    if (!downloadUrl) {
      const source = file.sandboxUrl ?? file.filename ?? file.url;
      errors.push(`${source}: no ChatGPT download URL found`);
      continue;
    }
    try {
      const response = await fetch(downloadUrl, {
        headers: {
          cookie: cookieHeader,
          "user-agent": "Mozilla/5.0",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`download failed: ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type");
      const filename = resolveDownloadedFilename({
        file,
        contentDisposition: response.headers.get("content-disposition"),
        contentType,
        index,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const artifact = await writeBinaryBrowserArtifact({
        sessionId,
        kind: "file",
        filename,
        contents: buffer,
        label: file.label || filename,
        mimeType: contentType ?? file.mimeType,
        sourceUrl: file.sandboxUrl ?? downloadUrl,
        logger,
      });
      if (artifact) {
        savedFiles.push({
          ...artifact,
          kind: "file",
          url: downloadUrl,
          finalUrl: response.url,
          sandboxUrl: file.sandboxUrl,
          filename,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file.filename ?? file.downloadUrl ?? file.url}: ${message}`);
      logger?.(
        `[browser] Failed to save downloadable file ${index + 1}/${files.length}: ${message}`,
      );
    }
  }

  return {
    saved: savedFiles.length > 0,
    fileCount: files.length,
    savedFiles,
    errors,
  };
}

export async function collectChatGptFileArtifacts(params: {
  Runtime: ChromeClient["Runtime"];
  Network: ChromeClient["Network"];
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  sessionId?: string;
}): Promise<{
  files: BrowserDownloadableFile[];
  savedFiles: SavedBrowserFile[];
  fileCount: number;
}> {
  const files = await readAssistantDownloadableFiles(
    params.Runtime,
    params.minTurnIndex ?? undefined,
  ).catch(() => []);
  if (files.length === 0) {
    return { files, savedFiles: [], fileCount: 0 };
  }

  const saved = await saveChatGptDownloadableFiles({
    Network: params.Network,
    files,
    sessionId: params.sessionId,
    logger: params.logger,
  });
  if (!saved.saved) {
    const detail = saved.errors.length > 0 ? `\n${saved.errors.join("\n")}` : "";
    params.logger?.(
      `[browser] Auto-save for downloadable files failed; returning metadata only.${detail}`,
    );
  }
  return {
    files,
    savedFiles: saved.savedFiles,
    fileCount: saved.fileCount,
  };
}

export const __test__ = {
  normalizeChatGptDownloadUrl,
  normalizeSandboxUrl,
};
