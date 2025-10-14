import type { Frame, Page } from "puppeteer";

const logPrefix = "[PressHoldSolver]";

interface PressHoldResult {
  detected: boolean;
  solved: boolean;
  reason?: string;
}

const KEYBOARD_TAB_ATTEMPTS = 25;
const PRE_ENTER_PAUSE_MS = 1200;
const BETWEEN_TAB_PAUSE_MS = 250;
const PRE_HOLD_PAUSE_MS = 800;
const HOLD_DURATION_MS = 10000;
const RESOLUTION_TIMEOUT_MS = 10000;
const RESOLUTION_POLL_INTERVAL_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PRESS_HOLD_REGEX = /press\s*&?\s*hold/i;

async function frameHasPressHold(frame: Frame): Promise<boolean> {
  try {
    return await frame.evaluate((regexSource) => {
      const regex = new RegExp(regexSource, "i");
      const allButtons = Array.from(
        document.querySelectorAll("button, [role='button']")
      );
      return allButtons.some((element) => {
        const text =
          element.textContent ??
          element.getAttribute("aria-label") ??
          element.getAttribute("data-text");
        return text ? regex.test(text) : false;
      });
    }, PRESS_HOLD_REGEX.source);
  } catch {
    console.debug(`${logPrefix} Frame evaluation failed while searching for button`);
    return false;
  }
}

async function activeElementMatches(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((regexSource) => {
      const active = document.activeElement;
      if (!active) return false;
      const regex = new RegExp(regexSource, "i");
      const candidates = [
        active.textContent ?? "",
        active.getAttribute("aria-label") ?? "",
        active.getAttribute("data-text") ?? "",
      ];
      return candidates.some((value) => (value ? regex.test(value) : false));
    }, PRESS_HOLD_REGEX.source);
  } catch {
    console.debug(`${logPrefix} Unable to read activeElement`);
    return false;
  }
}

async function detectChallenge(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await frameHasPressHold(frame)) {
      return true;
    }
  }
  return false;
}

async function hasPerimeterxSignals(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const regex = /perimeterx|press.?hold|px-cloud|pxinterceptors/i;
      const scripts = Array.from(document.querySelectorAll("script")).some(
        (script) => {
          const src = script.getAttribute("src") || "";
          return regex.test(src);
        }
      );
      const iframes = Array.from(document.querySelectorAll("iframe")).some(
        (iframe) => {
          const src = iframe.getAttribute("src") || "";
          const id = iframe.getAttribute("id") || "";
          const title = iframe.getAttribute("title") || "";
          return regex.test(src) || regex.test(id) || regex.test(title);
        }
      );
      const globals =
        typeof (window as any)._pxAppId !== "undefined" ||
        typeof (window as any).pxsin !== "undefined" ||
        typeof (window as any)._pxOnload !== "undefined";
      return scripts || iframes || globals;
    });
  } catch {
    console.debug(`${logPrefix} Unable to evaluate PerimeterX signals`);
    return false;
  }
}

async function pressAndHold(page: Page): Promise<void> {
  await page.keyboard.down("Enter");
  await sleep(HOLD_DURATION_MS);
  await page.keyboard.up("Enter");
}

export async function trySolvePressAndHoldChallenge(
  page: Page
): Promise<PressHoldResult> {
  const directDetection = await detectChallenge(page);
  const pxSignals = await hasPerimeterxSignals(page);
  const shouldAttempt = directDetection || pxSignals;

  console.log(`${logPrefix} Detected=${directDetection} pxSignals=${pxSignals}`);

  if (!shouldAttempt) {
    return { detected: false, solved: false };
  }

  await page.keyboard.press("Enter").catch(() => {});
  await sleep(PRE_ENTER_PAUSE_MS);

  let focused = await activeElementMatches(page);
  console.log(`${logPrefix} Initial focus=${focused}`);

  for (
    let attempt = 0;
    attempt < KEYBOARD_TAB_ATTEMPTS && !focused;
    attempt++
  ) {
    await page.keyboard.press("Tab").catch(() => {});
    await sleep(BETWEEN_TAB_PAUSE_MS);
    focused = await activeElementMatches(page);
    console.log(`${logPrefix} Tab attempt ${attempt + 1}, focused=${focused}`);
  }

  await sleep(PRE_HOLD_PAUSE_MS);
  await pressAndHold(page);
  await sleep(600);

  let stillPresent = true;
  const endTime = Date.now() + RESOLUTION_TIMEOUT_MS;
  while (Date.now() < endTime) {
    stillPresent = await detectChallenge(page);
    if (!stillPresent) {
      break;
    }
    await sleep(RESOLUTION_POLL_INTERVAL_MS);
    console.log(`${logPrefix} Polling... stillPresent=${stillPresent}`);
  }

  console.log(`${logPrefix} Result detected=${shouldAttempt} solved=${!stillPresent} focused=${focused}`);

  return {
    detected: shouldAttempt,
    solved: !stillPresent,
    reason: !stillPresent
      ? undefined
      : focused
        ? "Press-and-hold challenge still present after keyboard simulation"
        : "Unable to focus press-and-hold control via keyboard (possible closed shadow DOM)",
  };
}
