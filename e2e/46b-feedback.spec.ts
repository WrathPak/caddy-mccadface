import { test, expect } from './helpers'

test('Give feedback, from the Help menu and the command, starts an email to the author with the browser in it', async ({ app, page }) => {
  await page.addInitScript(() => { ;(window as unknown as Record<string, unknown>).__e2eFeedback = [] })
  await app.open()
  await page.getByTestId('help-menu').click()
  await page.getByRole('menuitem', { name: 'Give feedback' }).click()
  await app.ev((c) => c.runCommand('help.feedback'))
  const links = await page.evaluate(() => (window as unknown as { __e2eFeedback: string[] }).__e2eFeedback)
  expect(links).toHaveLength(2)
  const url = new URL(links[0])
  expect(url.protocol).toBe('mailto:')
  expect(url.pathname).toBe('brett.hollifield@gmail.com')
  expect(url.searchParams.get('subject')).toBe('CADdy McCADFace feedback')
  expect(url.searchParams.get('body')).toContain('Browser: Mozilla/')
})

test('the GitHub logo at the top right links to the repo in a new tab', async ({ app, page }) => {
  await app.open()
  const link = page.getByTestId('github-link')
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://github.com/WrathPak/caddy-mccadface')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
})
