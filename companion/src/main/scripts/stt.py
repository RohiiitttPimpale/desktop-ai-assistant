import sys
import os
import json

# Compatibility shim: PyAV v14+ removed the metadata_errors kwarg that
# faster-whisper passes to av.open(). Strip it transparently so both old and
# new PyAV versions work without requiring a downgrade.
try:
    import av as _av
    _orig_av_open = _av.open
    def _compat_av_open(file, *args, **kwargs):
        kwargs.pop('metadata_errors', None)
        return _orig_av_open(file, *args, **kwargs)
    _av.open = _compat_av_open
except ImportError:
    pass  # av not installed; faster_whisper will raise its own error later

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