import sys
from pathlib import Path

# Put the tool's parent dir (so `import google_chat.client` resolves) and the
# Centaur root (so `centaur_sdk` resolves) on the path — the deployed test
# runner sets these via PYTHONPATH; this keeps the suite runnable standalone.
_parents = Path(__file__).resolve().parents
for _p in (_parents[2], _parents[4]):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
