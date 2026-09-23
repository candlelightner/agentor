import { test, expect, type Page, type TestInfo } from '@playwright/test';

async function fontAndIconsReady(page: Page) {
  await expect(page.locator('aside.agentor-sidebar')).toBeVisible();
  await expect.poll(() => page.locator('aside .iconify').count()).toBeGreaterThan(20);
  // Nuxt can register the stylesheet after the initial fonts.ready promise
  // resolves. Wait for an actual loaded face, not just a fallback font check.
  await expect.poll(() => page.evaluate(async () => {
    const faces = await document.fonts.load('400 14px "Inter Variable"');
    return faces.length > 0 && faces.every((face) => face.status === 'loaded');
  }), { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => document.fonts.ready);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of ['normal', 'narrow'] as const) {
    test(`${theme} admin ${width}: real controls, icons, nested groups`, async ({ page }, testInfo) => {
      await page.goto(`/?theme=${theme}&role=admin&width=${width}`);
      await fontAndIconsReady(page);
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
      else await expect(page.locator('html')).not.toHaveClass(/dark/);
      await expect(page.locator('aside [data-theme-toggle] button')).toHaveCount(3);
      await expect(page.locator('.sidebar-worker-group')).toHaveCount(2);
      await expect(page.locator('.sidebar-worker-card')).toHaveCount(3);
      await expect(page.locator('.sidebar-worker-card-admin')).toHaveCount(1);
      await expect(page.locator('.sidebar-admin-zone')).toBeVisible();
      // Guard against incomplete Tailwind scanning of the external components.
      await expect(page.getByTestId('open-instance-backups')).toHaveCSS('grid-column', 'span 2 / span 2');
      await expect(page.locator('aside [data-tab-id="workers"]')).toHaveClass(/sidebar-tab-active/);

      const style = await page.evaluate(() => {
        const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        return {
          sidebarWidth: document.querySelector('aside')!.getBoundingClientRect().width,
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          font: css('aside').fontFamily,
          tabAccent: css('.sidebar-tab-active').borderBottomColor,
          ordinaryAccent: css('.sidebar-worker-card-active').borderTopColor,
          adminAccent: css('.sidebar-worker-card-admin').borderTopColor,
          cardRadius: parseFloat(css('.sidebar-worker-card').borderRadius),
        };
      });
      expect(style.sidebarWidth).toBe(width === 'narrow' ? 200 : 420);
      expect(style.pageScrollWidth).toBeLessThanOrEqual(style.viewportWidth);
      expect(style.font).toContain('Inter Variable');
      expect(style.tabAccent).toBe('rgb(181, 152, 97)');
      expect(style.ordinaryAccent).toBe('rgb(181, 152, 97)');
      expect(style.adminAccent).not.toBe('rgb(181, 152, 97)');
      expect(style.cardRadius).toBeGreaterThanOrEqual(4);
      expect(style.cardRadius).toBeLessThanOrEqual(6);
      await capture(page, testInfo, `${theme}-admin-${width}-workers`);
    });
  }

  test(`${theme} ordinary and archived states`, async ({ page }, testInfo) => {
    await page.goto(`/?theme=${theme}&role=ordinary&width=normal`);
    await fontAndIconsReady(page);
    await expect(page.locator('.sidebar-admin-zone')).toHaveCount(0);
    await expect(page.locator('.sidebar-worker-card-admin')).toHaveCount(0);
    await capture(page, testInfo, `${theme}-ordinary-workers`);

    await page.locator('aside [data-tab-id="archived"]').click();
    await expect(page.locator('.sidebar-archived-group')).toHaveCount(2);
    await expect(page.locator('.sidebar-archived-card')).toHaveCount(1);
    await capture(page, testInfo, `${theme}-ordinary-archived`);
  });

  test(`${theme} active admin card stays red`, async ({ page }, testInfo) => {
    await page.goto(`/?theme=${theme}&role=admin&active=admin`);
    await fontAndIconsReady(page);
    const admin = page.locator('.sidebar-worker-card-admin.sidebar-worker-card-active');
    await expect(admin).toHaveCount(1);
    const color = await admin.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(color).not.toBe('rgb(181, 152, 97)');
    await capture(page, testInfo, `${theme}-admin-active`);
  });
}

test('theme toggle and sidebar actions retain behavior', async ({ page }) => {
  await page.goto('/?theme=dark&role=admin');
  await fontAndIconsReady(page);
  const buttons = page.locator('aside [data-theme-toggle] button');
  await buttons.nth(1).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await buttons.nth(2).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('aside [data-tab-id="stopped"]').click();
  await expect(page.locator('aside [data-tab-id="stopped"]')).toHaveClass(/sidebar-tab-active/);
  await page.locator('aside').getByRole('button', { name: '+ New Worker' }).click();
  expect(await page.evaluate(() => (window as any).__lastAction)).toBe('newWorker');
  await page.locator('aside').getByRole('button', { name: 'Admin workspace' }).click();
  expect(await page.evaluate(() => (window as any).__lastAction)).toBe('openAdminWorkspace');
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} narrow management button labels stay within their buttons`, async ({ page }, testInfo) => {
    await page.goto(`/?theme=${theme}&role=admin&width=narrow`);
    await fontAndIconsReady(page);
    const overflow = await page.evaluate(() =>
      ['Backup management', 'Image catalog', 'Host mount permissions', 'Hardware', 'Admin workspace', 'Management MCP', 'Instance disaster recovery'].flatMap((label) => {
        const button = Array.from(document.querySelectorAll('aside button')).find((item) => item.textContent?.includes(label));
        if (!button) return [`Missing button: ${label}`];
        return button.scrollWidth > button.clientWidth + 1
          ? [`${label}: ${button.scrollWidth}px content in ${button.clientWidth}px button`]
          : [];
      }),
    );
    await capture(page, testInfo, `${theme}-admin-narrow-overflow`);
    expect(overflow).toEqual([]);
  });
}
