import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { mkdirSync, existsSync, copyFileSync } from 'node:fs'

// Vite plugin to copy Python scripts to output directory
function pythonScriptsPlugin() {
  const scripts = ['wake.py', 'stt.py', 'piper-tts.py'];
  
  return {
    name: 'python-scripts',
    writeBundle() {
      const srcDir = resolve(__dirname, 'src/main/scripts');
      const outDir = resolve(__dirname, 'out/main/scripts');
      
      if (!existsSync(srcDir)) return;
      
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }
      
      // Copy Python scripts
      for (const script of scripts) {
        const src = resolve(srcDir, script);
        const dest = resolve(outDir, script);
        if (existsSync(src)) {
          copyFileSync(src, dest);
          console.log(`[python-scripts] Copied ${script} to ${dest}`);
        }
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [pythonScriptsPlugin()],
  },
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { overlay: resolve(__dirname, 'src/renderer/overlay/index.html') }
      }
    }
  }
})