import { expect, test } from '@playwright/test';

const runId = process.env.TEAMVAULT_E2E_RUN_ID;
const ownerEmail = `teamvault-e2e-${runId}-owner@e2e.test`;
const memberEmail = `teamvault-e2e-${runId}-member@e2e.test`;
const password = 'TeamVault browser test password 2026';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

test('browser collaboration, private file access, workspace isolation, and realtime updates', async ({ page, browser }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await register(page, ownerEmail, 'Workspace Owner');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.getByLabel('Workspace name').fill('E2E Owner Workspace');
  const workspaceResponse = page.waitForResponse((response) => response.url().endsWith('/api/workspaces') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const workspace = (await (await workspaceResponse).json()).workspace;
  await page.goto(`/app/workspaces/${workspace.id}`);
  await expect(page.getByRole('heading', { name: 'E2E Owner Workspace' })).toBeVisible();
  await expect(page.getByText('Live updates connected')).toBeVisible();

  await page.getByLabel('Project name').fill('E2E Product Project');
  await page.getByRole('button', { name: 'Create project' }).click();
  const projectHref = await page.getByRole('link', { name: /E2E Product Project/ }).getAttribute('href');
  const projectId = projectHref.match(/projects\/([0-9a-f-]+)/iu)[1];
  await page.goto(projectHref);
  await expect(page.getByRole('heading', { name: 'E2E Product Project' })).toBeVisible();
  await expect(page.getByText('Live updates connected')).toBeVisible();

  await page.getByLabel('Title').fill('E2E task');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByLabel('Task title')).toHaveValue('E2E task');
  const taskBlock = page.locator('.task-block').first();
  await taskBlock.getByText('Comments and files for this task').click();
  await taskBlock.getByLabel('Add a comment').fill('Task discussion from browser');
  await taskBlock.getByRole('button', { name: 'Post comment' }).click();
  await expect(taskBlock.getByText('Task discussion from browser')).toBeVisible();

  const taskFileInput = taskBlock.locator('input[type=file]');
  const taskUpload = page.waitForResponse((response) => response.url().includes(`/tasks/`) && response.url().endsWith('/files') && response.request().method() === 'POST');
  await taskFileInput.setInputFiles({ name: 'task-note.pdf', mimeType: 'application/pdf', buffer: pdf });
  const taskFile = (await (await taskUpload).json()).file;
  const taskFileItem = taskBlock.locator('.file-list li').filter({ hasText: 'task-note.pdf' });
  await expect(taskFileItem).toBeVisible();
  const taskDownload = page.waitForEvent('download');
  await taskFileItem.getByRole('button', { name: 'Download' }).click();
  expect((await taskDownload).suggestedFilename()).toBe('task-note.pdf');

  const projectComment = page.getByLabel('Add a comment').last();
  await projectComment.fill('Project discussion from owner');
  await page.getByRole('button', { name: 'Post comment' }).last().click();
  await expect(page.getByText('Project discussion from owner')).toBeVisible();

  let projectFileId;
  page.on('response', async (response) => {
    if (response.url().endsWith('/files') && response.request().method() === 'POST' && !response.url().includes('/tasks/')) {
      projectFileId = (await response.json()).file.id;
    }
  });
  const projectFileInput = page.locator('.collaboration-grid input[type=file]');
  await projectFileInput.setInputFiles({ name: 'project-plan.pdf', mimeType: 'application/pdf', buffer: pdf });
  const projectFileItem = page.locator('.file-list li').filter({ hasText: 'project-plan.pdf' });
  await expect(projectFileItem).toBeVisible();
  await expect.poll(() => projectFileId).toBeTruthy();
  const projectDownload = page.waitForEvent('download');
  await projectFileItem.getByRole('button', { name: 'Download' }).click();
  expect((await projectDownload).suggestedFilename()).toBe('project-plan.pdf');
  await projectFileItem.getByRole('button', { name: 'Delete' }).click();
  await expect(projectFileItem).toHaveCount(0);

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await register(memberPage, memberEmail, 'Workspace Member');
  await expect(memberPage.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await memberPage.getByLabel('Workspace name').fill('E2E Other Workspace');
  await memberPage.getByRole('button', { name: 'Create workspace' }).click();
  const otherWorkspaceLink = await memberPage.getByRole('link', { name: /E2E Other Workspace/ }).last().getAttribute('href');
  const otherWorkspaceId = otherWorkspaceLink.match(/workspaces\/([0-9a-f-]+)/iu)[1];
  await memberPage.goto(otherWorkspaceLink);
  await memberPage.getByLabel('Project name').fill('Other Tenant Project');
  await memberPage.getByRole('button', { name: 'Create project' }).click();
  const otherProjectHref = await memberPage.getByRole('link', { name: /Other Tenant Project/ }).getAttribute('href');
  const otherProjectId = otherProjectHref.match(/projects\/([0-9a-f-]+)/iu)[1];
  await memberPage.goto(otherProjectHref);
  let otherFileId;
  memberPage.on('response', async (response) => {
    if (response.url().endsWith('/files') && response.request().method() === 'POST') otherFileId = (await response.json()).file.id;
  });
  const otherFileInput = memberPage.locator('.collaboration-grid input[type=file]');
  await otherFileInput.setInputFiles({ name: 'private-other.pdf', mimeType: 'application/pdf', buffer: pdf });
  const otherFileItem = memberPage.locator('.file-list li').filter({ hasText: 'private-other.pdf' });
  await expect(otherFileItem).toBeVisible();

  await page.goto(`/app/workspaces/${workspace.id}`);
  await page.getByLabel('Member email').fill(memberEmail);
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();
  await memberPage.goto(projectHref);
  await expect(memberPage.getByText('Live updates connected')).toBeVisible();
  await memberPage.locator('.task-collaboration').first().locator('summary').click();
  const memberFileItem = memberPage.locator('.file-list li').filter({ hasText: 'task-note.pdf' });
  await expect(memberFileItem.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  await page.goto(projectHref);
  await page.getByLabel('Add a comment').last().fill('Live update delivered to workspace member');
  await page.getByRole('button', { name: 'Post comment' }).last().click();
  await expect(memberPage.getByText('Live update delivered to workspace member')).toBeVisible();

  const deniedResourceStatus = await page.evaluate(async ({ workspaceId, projectId }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/projects/${projectId}`);
    return response.status;
  }, { workspaceId: otherWorkspaceId, projectId: otherProjectId });
  expect(deniedResourceStatus).toBe(404);
  const deniedFileStatus = await page.evaluate(async ({ workspaceId, projectId, fileId }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/files/${fileId}`);
    return response.status;
  }, { workspaceId: workspace.id, projectId, fileId: otherFileId });
  expect(deniedFileStatus).toBe(404);

  await page.goto(`/app/workspaces/${workspace.id}`);
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.getByText('Project created')).toBeVisible();
  await expect(page.getByText('Task created')).toBeVisible();
  await expect(page.getByText('Comment added')).toHaveCount(3);

  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await expect(page).toHaveURL(/\/login$/u);
  await page.goto(otherProjectHref);
  await expect(page).toHaveURL(/\/login$/u);
  await memberContext.close();
});

async function register(page, email, displayName) {
  await page.goto('/register');
  await page.getByLabel('Name').fill(displayName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}
