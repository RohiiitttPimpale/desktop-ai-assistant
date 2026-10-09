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

export default defineConfig(({ command }) => {
  // Safety net: electron-vite inlines MAIN_VITE_* env vars into the main
  // bundle at build time. The app reads keys at runtime (env / .env file),
  // so exporting them during a build would only risk baking secrets into
  // the artifact. (Verified not currently an issue — see OPTIMIZATION_LOG
  // SEC-009 — this warning keeps it that way.)
  if (command === 'build') {
    for (const key of ['MAIN_VITE_GEMINI_API_KEY', 'MAIN_VITE_GROQ_API_KEY']) {
      if (process.env[key]) {
        console.warn(
          `\n[security] WARNING: ${key} is set in the build environment — electron-vite may inline it into out/main. Unset it and let the app load keys at runtime.\n`
        )
      }
    }
  }

  return {
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
  }
})