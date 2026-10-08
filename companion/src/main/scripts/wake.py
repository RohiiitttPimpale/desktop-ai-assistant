import sys
import os
import struct
import pvporcupine
import pyaudio

def main():
    access_key = os.environ.get('PORCUPINE_ACCESS_KEY', '')
    keyword = os.environ.get('PORCUPINE_KEYWORD', 'hey google')
    
    if not access_key:
        print('[wake] MISSING_ACCESS_KEY: Porcupine requires PORCUPINE_ACCESS_KEY. Voice control active via Push-to-Talk (Ctrl+Alt+V) & UI mic button.', flush=True)
        # Keep process waiting quietly until terminated rather than failing in a crash loop
        try:
            while True:
                import time
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        return

    keyword_path = os.environ.get('PORCUPINE_KEYWORD_FILE', '')

    try:
        if keyword_path and os.path.exists(keyword_path):
            porcupine = pvporcupine.create(access_key=access_key, keyword_paths=[keyword_path])
        else:
            porcupine = pvporcupine.create(access_key=access_key, keywords=[keyword])
        
        pa = pyaudio.PyAudio()
        audio_stream = pa.open(
            rate=porcupine.sample_rate,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            frames_per_buffer=porcupine.frame_length
        )
        
        print(f'[wake] Listening for "{keyword}"...', flush=True)
        
        while True:
            pcm = audio_stream.read(porcupine.frame_length, exception_on_overflow=False)
            pcm = struct.unpack_from('h' * porcupine.frame_length, pcm)
            result = porcupine.process(pcm)
            if result >= 0:
                print('[wake] WAKE_WORD_DETECTED', flush=True)
                
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f'[wake] ERROR: {e}', flush=True)
        sys.exit(1)
    finally:
        if 'audio_stream' in locals():
            audio_stream.close()
        if 'pa' in locals():
            pa.terminate()
        if 'porcupine' in locals():
            porcupine.delete()

if __name__ == '__main__':
    main()