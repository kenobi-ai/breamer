import type { HTTPRequest, Page } from "puppeteer";

const CMP_BLOCKLIST = [
  "cdn.cookielaw.org",
  "geolocation.onetrust.com",
  "consent.cookiebot.com",
  "consentcdn.cookiebot.com",
  "cmp.quantcast.com",
  "quantcast.mgr.consensu.org",
  "sdk.privacy-center.org",
  "api.privacy-center.org",
  "sdk.privacy-center.cloud",
  "app.usercentrics.eu",
  "manage.usercentrics.eu",
  "cmp.usercentrics.eu",
  "cdn.privacy-mgmt.com",
  "wrapper-api.privacy-mgmt.com",
  "consent.trustarc.com",
  "choices.trustarc.com",
  "cdn-cookieyes.com",
] as const;

const shouldBlock = (url: string) =>
  CMP_BLOCKLIST.some((host) => url.includes(host));

export async function applyCmpRequestBlocking(page: Page): Promise<void> {
  await page.setRequestInterception(true);

  page.on("request", (request: HTTPRequest) => {
    if (shouldBlock(request.url())) {
      request.abort().catch(() => {});
      return;
    }

    request.continue().catch(() => {});
  });
}
