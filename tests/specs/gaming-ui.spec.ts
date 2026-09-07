import { test, expect } from '@playwright/test';
import { HOST, CODE } from '../test-env';

test('gaming and settings remain usable through cancel, apply, rotation and repeated entry', async ({ page }) => {
  test.setTimeout(60000);
  const faults: string[]=[];page.on('pageerror',e=>faults.push(e.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().startsWith('Failed to load resource'))faults.push(message.text());});
  await page.goto('/');
  await page.getByRole('button',{name:'Get started',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByTestId('host-input').fill(HOST);await page.getByTestId('check-host').click();
  const code=page.getByTestId('code-input'),surface=page.getByTestId('screen-surface');
  await expect(code.or(surface).first()).toBeVisible({timeout:15000});
  if(await code.isVisible()){await code.fill(CODE);await page.getByTestId('pair-btn').click();}
  await expect(surface).toBeVisible({timeout:15000});
  await expect(page.getByTestId('panel-state')).toHaveCount(0,{timeout:20000});
  const openSettings=async()=>{await page.getByTestId('screen-menu').click();await page.getByTestId('stream-settings').click();await expect(page.getByTestId('apply-settings')).toBeVisible();};
  await openSettings();
  await expect(page.getByTestId('fps-60')).toBeDisabled();
  await expect(page.getByTestId('audio-toggle')).toHaveText('Off');
  await page.getByTestId('audio-toggle').click();
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  await openSettings();await expect(page.getByTestId('audio-toggle')).toHaveText('Off');
  await page.setViewportSize({width:844,height:390});
  await page.getByTestId('reset-settings').scrollIntoViewIfNeeded();await page.getByTestId('reset-settings').click();
  await page.getByTestId('audio-toggle').click();
  await page.getByTestId('apply-settings').scrollIntoViewIfNeeded();await page.getByTestId('apply-settings').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByTestId('toggle-keys').click();await page.getByTestId('toggle-keys').click();
  for(let i=0;i<2;i++) {
    await page.getByTestId('pointer-mode-gaming').click();
    await expect(page.getByTestId('gaming-sheet')).toBeVisible();
    await page.getByRole('button',{name:'Start gaming',exact:true}).click();
    await expect(page.getByRole('button',{name:'Exit gaming mode',exact:true})).toBeVisible();
    await page.setViewportSize({width:844,height:390});
    await expect(page.getByTestId('gamepad-a')).toBeVisible({timeout:15000});
    await page.screenshot({path:`screenshots/gaming-phone-${i}.png`});
    await page.getByRole('button',{name:'Exit gaming mode',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByTestId('control-dock')).toBeVisible();
  }
  expect(faults).toEqual([]);
});
