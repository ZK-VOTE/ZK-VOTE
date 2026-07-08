import { test, expect } from "@playwright/test";

test.describe("ZKVote Smoke Tests", () => {
  test("homepage loads and shows key elements", async ({ page }) => {
    await page.goto("/");

    // App renders without crashing
    await expect(page).toHaveTitle(/ZKVote/i);

    // Navbar is present with wallet connect button
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).toBeVisible();

    // Main content area loads
    await expect(page.locator("#root")).toBeVisible();
  });

  test("DAO list page loads", async ({ page }) => {
    await page.goto("/");

    // Look for DAOs heading or DAO list container
    const daoSection = page.getByText(/DAOs|Explore|Public Votes/i).first();
    await expect(daoSection).toBeVisible({ timeout: 10000 });
  });

  test("health endpoint is reachable", async ({ request }) => {
    const response = await request.get("https://server.zkvote.net/health");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.rpc.ok).toBe(true);
  });

  test("config endpoint returns valid contract IDs", async ({ request }) => {
    const response = await request.get("https://server.zkvote.net/config");
    expect(response.ok()).toBeTruthy();

    const config = await response.json();
    expect(config.votingContract).toMatch(/^C[A-Z0-9]{55}$/);
    expect(config.treeContract).toMatch(/^C[A-Z0-9]{55}$/);
    expect(config.commentsContract).toMatch(/^C[A-Z0-9]{55}$/);
    expect(config.rpcUrl).toContain("stellar.org");
    expect(config.networkPassphrase).toContain("Test SDF Network");
  });

  test("DAO list API returns data", async ({ request }) => {
    const response = await request.get("https://server.zkvote.net/daos");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.daos).toBeDefined();
    expect(Array.isArray(data.daos)).toBe(true);
  });

  test("static assets load correctly", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // Check that CSS loaded (page has styled content)
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // Check that JS executed (React rendered something into #root)
    const root = page.locator("#root");
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);
  });

  test("navigation works without errors", async ({ page }) => {
    // Collect console errors
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    await page.waitForTimeout(2000);

    // No critical JS errors
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("CORS")
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("wallet connect button is present", async ({ page }) => {
    await page.goto("/");

    // Look for connect wallet button
    const connectBtn = page
      .getByRole("button", { name: /connect|wallet/i })
      .first();
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
  });

  test("docs page loads", async ({ page }) => {
    await page.goto("/docs");

    // Docs page should have documentation content
    await expect(
      page.getByText(/documentation|architecture|how it works/i).first()
    ).toBeVisible({ timeout: 10000 });
  });
});
