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
// Pickup is the chip. ChatGPT's change handler empties its input whether it keeps the file or
// drops it, so an emptied input proves nothing. A FileList still sitting in the input Oracle
// filled is Oracle's own assignment, so it never counts either, and it is emptied before the file
// is sent again. A chip slower than the pickup wait would mean sending the file twice.
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
    if (await isAttachmentVisible(runtime, fileName, evidenceId, { countFileInput: false })) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(200);
  }
}

/**
 * Drops the record of the input a transfer filled. "clear" first empties that input if it still
 * holds the file, so a transfer the page never took is not left beside the next one.
 */
async function transferredInput(
  runtime: ChromeClient["Runtime"],
  key: string,
  fileName: string,
  action: "clear" | "forget",
): Promise<void> {
  await runtime.evaluate({
    expression: `(() => {
      const inputs = globalThis[${JSON.stringify(TRANSFERRED_INPUTS_KEY)}];
      const input = inputs?.get(${JSON.stringify(key)});
      inputs?.delete(${JSON.stringify(key)});
      const action = ${JSON.stringify(action)};
      if (action !== 'clear' || !(input instanceof HTMLInputElement)) return;
      if (!Array.from(input.files || []).some((file) => file?.name === ${JSON.stringify(fileName)})) return;
      // A transfer that could not use the files setter defines an own 'files' getter instead.
      if (Object.prototype.hasOwnProperty.call(input, 'files')) delete input.files;
      input.value = '';
    })()`,
    returnByValue: true,
  });
}
