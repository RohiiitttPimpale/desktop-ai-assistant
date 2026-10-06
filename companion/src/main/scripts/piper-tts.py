import sys
import json
import os
import wave
from piper import PiperVoice

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else ''
    model_path = os.environ.get('PIPER_MODEL', '')
    output_file = sys.argv[2] if len(sys.argv) > 2 else ''
    
    if not text:
        print(json.dumps({'error': 'No text provided'}), flush=True)
        sys.exit(1)
    
    if not model_path or not os.path.exists(model_path):
        print(json.dumps({'error': f'Piper model not found: {model_path}'}), flush=True)
        sys.exit(1)
    
    if not output_file:
        print(json.dumps({'error': 'No output file specified'}), flush=True)
        sys.exit(1)
    
    try:
        voice = PiperVoice.load(model_path)
        
        with wave.open(output_file, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(voice.config.sample_rate)
            
            for audio_bytes in voice.synthesize_stream_raw(text):
                wav_file.writeframes(audio_bytes)
        
        print(json.dumps({'success': True, 'output': output_file}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e)}), flush=True)
        sys.exit(1)

if __name__ == '__main__':
    main()