import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import { exec } from 'node:child_process'
import path from 'node:path'
import { getConfig, updateConfig } from './config'
import { getOverlay, notifyModelChanged, setSize, toggleVisibility } from './overlay'
import { getMaxAgentSteps, getPermissionLevel, setMaxAgentSteps, setPermissionLevel } from './tools'
import { startVoiceMode, stopVoiceMode, isVoiceModeActive, defaultVoiceCallbacks } from './voice/index'

let tray: Tray | null = null

export function createTray(): void {
  const iconPath = path.join(__dirname, '../../resources/icon.png')
  let icon = nativeImage.createEmpty()
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  } catch {
    // ignore missing icon
  }

  tray = new Tray(icon)
  tray.setToolTip('Miko Companion')
  tray.on('click', () => {
    toggleVisibility()
  })
  tray.on('right-click', () => {
    showContextMenu()
  })
}

export function showContextMenu(): void {
  if (!tray) return

  const perm = getPermissionLevel()
  const cfg = getConfig()

  const menu = Menu.buildFromTemplate([
    {
      label: 'Load VRM model...',
      click: async () => {
        const win = getOverlay() || undefined
        const { canceled, filePaths } = await dialog.showOpenDialog(win as BrowserWindow, {
          title: 'Select VRM Model',
          filters: [{ name: 'VRM Files', extensions: ['vrm'] }],
          properties: ['openFile']
        })
        if (!canceled && filePaths.length > 0) {
          updateConfig({ modelPath: filePaths[0] })
          notifyModelChanged()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Size',
      submenu: [
        {
          label: 'Small',
          type: 'radio',
          checked: cfg.size === 'small',
          click: () => setSize('small')
        },
        {
          label: 'Medium',
          type: 'radio',
          checked: cfg.size === 'medium',
          click: () => setSize('medium')
        },
        {
          label: 'Large',
          type: 'radio',
          checked: cfg.size === 'large',
          click: () => setSize('large')
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Permission Level',
      submenu: [
        {
          label: 'Read Only',
          type: 'radio',
          checked: perm === 'read-only',
          click: () => setPermissionLevel('read-only')
        },
        {
          label: 'Only Browser',
          type: 'radio',
          checked: perm === 'only-browser',
          click: () => setPermissionLevel('only-browser')
        },
        {
          label: 'Normal',
          type: 'radio',
          checked: perm === 'normal',
          click: () => setPermissionLevel('normal')
        },
        {
          label: 'Full Control',
          type: 'radio',
          checked: perm === 'full',
          click: () => setPermissionLevel('full')
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Voice Mode (Wake Word + Ctrl+Alt+V)',
      type: 'checkbox',
      checked: isVoiceModeActive(),
      click: (item) => {
        if (item.checked) startVoiceMode(defaultVoiceCallbacks())
        else stopVoiceMode()
      }
    },
    { type: 'separator' },
    {
      label: 'Maximum Loop Steps',
      submenu: [
        ...[3, 6, 8, 12, 15].map((steps) => ({
          label: steps.toString() + ' Steps',
          type: 'radio' as const,
          checked: getMaxAgentSteps() === steps,
          click: () => setMaxAgentSteps(steps)
        })),
        { type: 'separator' },
        {
          label: 'Custom Type-In...',
          click: () => {
            const psCmd = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('Enter the exact maximum number of loop steps:', 'Custom Loop Limit', '${getMaxAgentSteps()}')`
            exec(`powershell -NoProfile -Command "${psCmd}"`, { windowsHide: true }, (err, stdout) => {
              if (stdout) {
                const val = parseInt(stdout.trim(), 10)
                if (!isNaN(val) && val > 0) setMaxAgentSteps(val)
              }
            })
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.popUpContextMenu(menu)
}