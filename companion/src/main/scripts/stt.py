import sys
import os
import json
from faster_whisper import WhisperModel

def main():
    audio_file = sys.argv[1] if len(sys.argv) > 1 else ''
    model_size = os.environ.get('WHISPER_MODEL', 'small')
    device = os.environ.get('WHISPER_DEVICE', 'cpu')
    compute_type = os.environ.get('WHISPER_COMPUTE_TYPE', 'int8')
    
    if not audio_file or not os.path.exists(audio_file):
        print(json.dumps({'error': 'Audio file not found'}), flush=True)
        sys.exit(1)
    
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, info = model.transcribe(audio_file, beam_size=5, language='en')
        
        text = ' '.join([seg.text for seg in segments]).strip()
        print(json.dumps({'text': text, 'language': info.language}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e)}), flush=True)
        sys.exit(1)

if __name__ == '__main__':
    main()