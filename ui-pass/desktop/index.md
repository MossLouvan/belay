# Belay desktop UI pass: every page in all four looks

Branch ui/desktop-pass. Rendered from desktop/renderer in Chromium with the preload bridges mocked (connect 720x612, host 480x828 content size = the default windows minus the title bar). Inventory ids (H = host window, V = connect/viewer, D = display, S = seamless) match the PR.

 = the real unsigned Electron app driven over CDP: the picker switching looks in the connect window and the host window following live.

| State | Harbour | Night | Current | Fieldwork |
|---|---|---|---|---|
| D01-display-dock | ![harbour](harbour/D01-display-dock.png) | ![night](night/D01-display-dock.png) | ![current](current/D01-display-dock.png) | ![fieldwork](fieldwork/D01-display-dock.png) |
| D02-display-gaming | ![harbour](harbour/D02-display-gaming.png) | ![night](night/D02-display-gaming.png) | ![current](current/D02-display-gaming.png) | ![fieldwork](fieldwork/D02-display-gaming.png) |
| D03-display-live | ![harbour](harbour/D03-display-live.png) | ![night](night/D03-display-live.png) | ![current](current/D03-display-live.png) | ![fieldwork](fieldwork/D03-display-live.png) |
| H01-starting | ![harbour](harbour/H01-starting.png) | ![night](night/H01-starting.png) | ![current](current/H01-starting.png) | ![fieldwork](fieldwork/H01-starting.png) |
| H02-stopped | ![harbour](harbour/H02-stopped.png) | ![night](night/H02-stopped.png) | ![current](current/H02-stopped.png) | ![fieldwork](fieldwork/H02-stopped.png) |
| H03-busy-launchagent | ![harbour](harbour/H03-busy-launchagent.png) | ![night](night/H03-busy-launchagent.png) | ![current](current/H03-busy-launchagent.png) | ![fieldwork](fieldwork/H03-busy-launchagent.png) |
| H04-busy-other | ![harbour](harbour/H04-busy-other.png) | ![night](night/H04-busy-other.png) | ![current](current/H04-busy-other.png) | ![fieldwork](fieldwork/H04-busy-other.png) |
| H05-unlinked-signin | ![harbour](harbour/H05-unlinked-signin.png) | ![night](night/H05-unlinked-signin.png) | ![current](current/H05-unlinked-signin.png) | ![fieldwork](fieldwork/H05-unlinked-signin.png) |
| H05b-unlinked-claim-qr | ![harbour](harbour/H05b-unlinked-claim-qr.png) | ![night](night/H05b-unlinked-claim-qr.png) | ![current](current/H05b-unlinked-claim-qr.png) | ![fieldwork](fieldwork/H05b-unlinked-claim-qr.png) |
| H06-signin-code-step | ![harbour](harbour/H06-signin-code-step.png) | ![night](night/H06-signin-code-step.png) | ![current](current/H06-signin-code-step.png) | ![fieldwork](fieldwork/H06-signin-code-step.png) |
| H07-signin-error | ![harbour](harbour/H07-signin-error.png) | ![night](night/H07-signin-error.png) | ![current](current/H07-signin-error.png) | ![fieldwork](fieldwork/H07-signin-error.png) |
| H08-first-phone-open | ![harbour](harbour/H08-first-phone-open.png) | ![night](night/H08-first-phone-open.png) | ![current](current/H08-first-phone-open.png) | ![fieldwork](fieldwork/H08-first-phone-open.png) |
| H09-first-phone-closed | ![harbour](harbour/H09-first-phone-closed.png) | ![night](night/H09-first-phone-closed.png) | ![current](current/H09-first-phone-closed.png) | ![fieldwork](fieldwork/H09-first-phone-closed.png) |
| H10-pairing-code | ![harbour](harbour/H10-pairing-code.png) | ![night](night/H10-pairing-code.png) | ![current](current/H10-pairing-code.png) | ![fieldwork](fieldwork/H10-pairing-code.png) |
| H11-linked-phones | ![harbour](harbour/H11-linked-phones.png) | ![night](night/H11-linked-phones.png) | ![current](current/H11-linked-phones.png) | ![fieldwork](fieldwork/H11-linked-phones.png) |
| H12-pending-approval | ![harbour](harbour/H12-pending-approval.png) | ![night](night/H12-pending-approval.png) | ![current](current/H12-pending-approval.png) | ![fieldwork](fieldwork/H12-pending-approval.png) |
| H13-not-approved | ![harbour](harbour/H13-not-approved.png) | ![night](night/H13-not-approved.png) | ![current](current/H13-not-approved.png) | ![fieldwork](fieldwork/H13-not-approved.png) |
| H14-error | ![harbour](harbour/H14-error.png) | ![night](night/H14-error.png) | ![current](current/H14-error.png) | ![fieldwork](fieldwork/H14-error.png) |
| H15-perms-not-yet | ![harbour](harbour/H15-perms-not-yet.png) | ![night](night/H15-perms-not-yet.png) | ![current](current/H15-perms-not-yet.png) | ![fieldwork](fieldwork/H15-perms-not-yet.png) |
| H16-perms-relaunch | ![harbour](harbour/H16-perms-relaunch.png) | ![night](night/H16-perms-relaunch.png) | ![current](current/H16-perms-relaunch.png) | ![fieldwork](fieldwork/H16-perms-relaunch.png) |
| H17-windows-host | ![harbour](harbour/H17-windows-host.png) | ![night](night/H17-windows-host.png) | ![current](current/H17-windows-host.png) | ![fieldwork](fieldwork/H17-windows-host.png) |
| S01-seamless | ![harbour](harbour/S01-seamless.png) | ![night](night/S01-seamless.png) | ![current](current/S01-seamless.png) | ![fieldwork](fieldwork/S01-seamless.png) |
| V01-welcome | ![harbour](harbour/V01-welcome.png) | ![night](night/V01-welcome.png) | ![current](current/V01-welcome.png) | ![fieldwork](fieldwork/V01-welcome.png) |
| V02-feedback-tailscale | ![harbour](harbour/V02-feedback-tailscale.png) | ![night](night/V02-feedback-tailscale.png) | ![current](current/V02-feedback-tailscale.png) | ![fieldwork](fieldwork/V02-feedback-tailscale.png) |
| V03a-feedback-typing | ![harbour](harbour/V03a-feedback-typing.png) | ![night](night/V03a-feedback-typing.png) | ![current](current/V03a-feedback-typing.png) | ![fieldwork](fieldwork/V03a-feedback-typing.png) |
| V03b-feedback-bad | ![harbour](harbour/V03b-feedback-bad.png) | ![night](night/V03b-feedback-bad.png) | ![current](current/V03b-feedback-bad.png) | ![fieldwork](fieldwork/V03b-feedback-bad.png) |
| V03c-feedback-local | ![harbour](harbour/V03c-feedback-local.png) | ![night](night/V03c-feedback-local.png) | ![current](current/V03c-feedback-local.png) | ![fieldwork](fieldwork/V03c-feedback-local.png) |
| V04-where-expanded | ![harbour](harbour/V04-where-expanded.png) | ![night](night/V04-where-expanded.png) | ![current](current/V04-where-expanded.png) | ![fieldwork](fieldwork/V04-where-expanded.png) |
| V05-certificate | ![harbour](harbour/V05-certificate.png) | ![night](night/V05-certificate.png) | ![current](current/V05-certificate.png) | ![fieldwork](fieldwork/V05-certificate.png) |
| V06-connecting | ![harbour](harbour/V06-connecting.png) | ![night](night/V06-connecting.png) | ![current](current/V06-connecting.png) | ![fieldwork](fieldwork/V06-connecting.png) |
| V07-error | ![harbour](harbour/V07-error.png) | ![night](night/V07-error.png) | ![current](current/V07-error.png) | ![fieldwork](fieldwork/V07-error.png) |
| V08-paired-scrolled | ![harbour](harbour/V08-paired-scrolled.png) | ![night](night/V08-paired-scrolled.png) | ![current](current/V08-paired-scrolled.png) | ![fieldwork](fieldwork/V08-paired-scrolled.png) |
| V08-paired | ![harbour](harbour/V08-paired.png) | ![night](night/V08-paired.png) | ![current](current/V08-paired.png) | ![fieldwork](fieldwork/V08-paired.png) |
| V09-paired-no-virtual-scrolled | ![harbour](harbour/V09-paired-no-virtual-scrolled.png) | ![night](night/V09-paired-no-virtual-scrolled.png) | ![current](current/V09-paired-no-virtual-scrolled.png) | ![fieldwork](fieldwork/V09-paired-no-virtual-scrolled.png) |
| V09-paired-no-virtual | ![harbour](harbour/V09-paired-no-virtual.png) | ![night](night/V09-paired-no-virtual.png) | ![current](current/V09-paired-no-virtual.png) | ![fieldwork](fieldwork/V09-paired-no-virtual.png) |

## Real Electron

![electron-connect-current.png](electron/electron-connect-current.png)
![electron-connect-fieldwork.png](electron/electron-connect-fieldwork.png)
![electron-connect-harbour.png](electron/electron-connect-harbour.png)
![electron-connect-night.png](electron/electron-connect-night.png)
![electron-host-current.png](electron/electron-host-current.png)
![electron-host-fieldwork.png](electron/electron-host-fieldwork.png)
![electron-host-harbour.png](electron/electron-host-harbour.png)
![electron-host-night.png](electron/electron-host-night.png)
![electron-host-system.png](electron/electron-host-system.png)
