import type { Frame, Page } from "puppeteer";

interface PressHoldResult {
  detected: boolean;
  solved: boolean;
  reason?: string;
}

const KEYBOARD_TAB_ATTEMPTS = 25;
const HOLD_DURATION_MS = 8000;
const RESOLUTION_TIMEOUT_MS = 8000;
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

async function pressAndHold(page: Page): Promise<void> {
  await page.keyboard.down("Enter");
  await sleep(HOLD_DURATION_MS);
  await page.keyboard.up("Enter");
}

export async function trySolvePressAndHoldChallenge(
  page: Page
): Promise<PressHoldResult> {
  const detected = await detectChallenge(page);
  if (!detected) {
    return { detected: false, solved: false };
  }

  let focused = await activeElementMatches(page);

  for (
    let attempt = 0;
    attempt < KEYBOARD_TAB_ATTEMPTS && !focused;
    attempt++
  ) {
    await page.keyboard.press("Tab").catch(() => {});
    await sleep(150);
    focused = await activeElementMatches(page);
  }

  if (!focused) {
    return {
      detected: true,
      solved: false,
      reason: "Unable to focus press-and-hold control via keyboard",
    };
  }

  await sleep(120);
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
  }

  return {
    detected: true,
    solved: !stillPresent,
    reason: stillPresent
      ? "Press-and-hold challenge still present after keyboard simulation"
      : undefined,
  };
}
