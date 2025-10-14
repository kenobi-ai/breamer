import type { ElementHandle, Frame, Page } from "puppeteer";

interface PressHoldResult {
  detected: boolean;
  solved: boolean;
  reason?: string;
}

const PRESS_HOLD_TEXT = /press\s*&?\s*hold/i;

const randomJitter = (min: number, max: number): number =>
  Math.random() * (max - min) + min;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function getPressHoldButton(
  frame: Frame
): Promise<ElementHandle<Element> | null> {
  const buttons = await frame.$$("button");
  for (const button of buttons) {
    let matchesChallenge = false;
    try {
      const text = await frame.evaluate(
        (el) => el.textContent ?? "",
        button
      );
      matchesChallenge = PRESS_HOLD_TEXT.test(text);
    } catch {
      // Ignore evaluation errors and continue scanning.
    }
    if (matchesChallenge) {
      return button;
    }
    await button.dispose().catch(() => {});
  }
  return null;
}

export async function trySolvePressAndHoldChallenge(
  page: Page
): Promise<PressHoldResult> {
  for (const frame of page.frames()) {
    let button: ElementHandle<Element> | null = null;
    try {
      button = await getPressHoldButton(frame);
      if (!button) {
        continue;
      }

      await button.evaluate((el) =>
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
      );

      const boundingBox = await button.boundingBox();
      if (!boundingBox) {
        return {
          detected: true,
          solved: false,
          reason: "Press & Hold button not visible",
        };
      }

      const centerX = boundingBox.x + boundingBox.width / 2;
      const centerY = boundingBox.y + boundingBox.height / 2;

      await page.mouse.move(
        centerX + randomJitter(-4, 4),
        centerY + randomJitter(-4, 4),
        { steps: 8 }
      );

      await page.mouse.down({ button: "left" });

      const holdDuration = 2200 + randomJitter(-400, 600);
      const jitterSteps = 3 + Math.floor(Math.random() * 3);
      for (let step = 0; step < jitterSteps; step++) {
        await sleep(holdDuration / (jitterSteps + 1));
        await page.mouse.move(
          centerX + randomJitter(-6, 6),
          centerY + randomJitter(-6, 6),
          { steps: 4 }
        );
      }

      await sleep(holdDuration / (jitterSteps + 1));
      await page.mouse.up({ button: "left" });

      const cleared = await frame
        .waitForFunction(() => {
          const buttons = Array.from(
            document.querySelectorAll("button")
          );
          return !buttons.some((el) =>
            /press\s*&?\s*hold/i.test(el.textContent ?? "")
          );
        }, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (cleared) {
        return { detected: true, solved: true };
      }

      return {
        detected: true,
        solved: false,
        reason: "Challenge still present after simulated hold",
      };
    } catch (error) {
      return {
        detected: Boolean(button),
        solved: false,
        reason:
          error instanceof Error ? error.message : "Unknown press-hold error",
      };
    } finally {
      if (button) {
        await button.dispose().catch(() => {});
      }
    }
  }

  return { detected: false, solved: false };
}
