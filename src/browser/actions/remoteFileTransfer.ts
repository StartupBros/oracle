import path from "node:path";
import type { ChromeClient, BrowserAttachment, BrowserLogger } from "../types.js";
import { FILE_INPUT_SELECTORS } from "../constants.js";
import { isAttachmentVisible, waitForAttachmentVisible } from "./attachments.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import {
  TRANSFERRED_INPUTS_KEY,
  transferAttachmentViaDataTransfer,
} from "./attachmentDataTransfer.js";
import { beginAttachmentEvidence } from "./attachmentEvidence.js";

// ChatGPT shows the prompt box before it mounts and wires the composer's file inputs, and can
// re-render the composer while the page finishes loading. A transfer made in that window is
// dropped without a trace: no chip, no upload request. So wait for an input to exist, and repeat
// a transfer ChatGPT never picked up. An accepted transfer shows its chip within about a second.
//
// Pickup is the chip, or ChatGPT's change handler clearing the input Oracle filled; the handler
// clears it when it takes the file. A FileList still sitting in that input is Oracle's own
// assignment, the sign of a dropped transfer, so it never counts as the file being visible.
const FILE_INPUT_WAIT_MS = 15_000;
const PICKUP_WAIT_MS = 3_000;
const MAX_TRANSFERS = 3;

export interface RemoteTransferTiming {
  inputWaitMs?: number;
  pickupWaitMs?: number;
}

/**
 * Upload file to remote Chrome by transferring content via CDP
 * Used when browser is on a different machine than CLI
 */
export async function uploadAttachmentViaDataTransfer(
  deps: { runtime: ChromeClient["Runtime"]; dom?: ChromeClient["DOM"]; navigationUrl?: string },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
  timing: RemoteTransferTiming = {},
): Promise<void> {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error("DOM domain unavailable while uploading attachments.");
  }

  logger(`Transferring ${path.basename(attachment.path)} to remote browser...`);

  for (let transfer = 1; ; transfer += 1) {
    const fileInputSelector = await waitForFileInputSelector(
      dom,
      timing.inputWaitMs ?? FILE_INPUT_WAIT_MS,
    );
    if (!fileInputSelector) {
      await logDomFailure(runtime, logger, "file-input");
      throw new Error("Unable to locate ChatGPT file attachment input.");
    }

    const evidenceId = await beginAttachmentEvidence(runtime, path.basename(attachment.path));
    const transferResult = await transferAttachmentViaDataTransfer(
      runtime,
      attachment,
      fileInputSelector,
      deps.navigationUrl,
      evidenceId,
    );
    const { fileName } = transferResult;

    logger(`File transferred: ${fileName} (${transferResult.size} bytes)`);

    try {
      // Give ChatGPT a moment to process the file
      await delay(500);
      if (
        transfer < MAX_TRANSFERS &&
        !(await waitForPickup(runtime, fileName, timing.pickupWaitMs ?? PICKUP_WAIT_MS, evidenceId))
      ) {
        await transferredInput(runtime, evidenceId, fileName, "clear");
        logger(
          `ChatGPT did not pick up ${fileName}; transferring it again (${transfer + 1}/${MAX_TRANSFERS}).`,
        );
        continue;
      }
      await waitForAttachmentVisible(runtime, fileName, 10_000, logger, evidenceId, {
        countFileInput: false,
      });
    } finally {
      await transferredInput(runtime, evidenceId, fileName, "forget");
    }

    logger("Attachment queued");
    return;
  }
}

async function waitForFileInputSelector(
  dom: ChromeClient["DOM"],
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const documentNode = await dom.getDocument();
    for (const selector of FILE_INPUT_SELECTORS) {
      const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
      if (result.nodeId) {
        return selector;
      }
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(250);
  }
}

async function waitForPickup(
  runtime: ChromeClient["Runtime"],
  fileName: string,
  timeoutMs: number,
  evidenceId: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A cleared input means the handler took the file even if its chip is still rendering, so
    // transferring again would attach it twice.
    if (
      (await isAttachmentVisible(runtime, fileName, evidenceId, { countFileInput: false })) ||
      (await transferredInput(runtime, evidenceId, fileName, "read")) === "consumed"
    ) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(200);
  }
}

/**
 * The input a transfer filled: "read" reports whether it still holds the file ("holding"), was
 * cleared ("consumed"), or is no longer recorded ("unknown", e.g. after a navigation). "clear"
 * empties a transfer the page never took, so the retry starts from the page's own state, and
 * "forget" drops the record; both return the same state as "read".
 */
async function transferredInput(
  runtime: ChromeClient["Runtime"],
  key: string,
  fileName: string,
  action: "read" | "clear" | "forget",
): Promise<"holding" | "consumed" | "unknown"> {
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const inputs = globalThis[${JSON.stringify(TRANSFERRED_INPUTS_KEY)}];
      const input = inputs?.get(${JSON.stringify(key)});
      if (!(input instanceof HTMLInputElement)) return 'unknown';
      const holding = Array.from(input.files || []).some((file) => file?.name === ${JSON.stringify(fileName)});
      const action = ${JSON.stringify(action)};
      if (action !== 'read') inputs.delete(${JSON.stringify(key)});
      if (action === 'clear' && holding) {
        // A transfer that could not use the files setter defines an own 'files' getter instead.
        if (Object.prototype.hasOwnProperty.call(input, 'files')) delete input.files;
        input.value = '';
      }
      return holding ? 'holding' : 'consumed';
    })()`,
    returnByValue: true,
  });
  const state = result?.value;
  return state === "holding" || state === "consumed" ? state : "unknown";
}
