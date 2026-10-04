#!/usr/bin/env python3
"""Compatibility entry point for the immutable fleet workflow's routing gate."""
import subprocess
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
if (root / '.github/workflows/trusted-pr.yml').exists():
    raise SystemExit('Retired OIDC routing workflow must stay removed.')
subprocess.run([sys.executable, str(root / 'scripts/test-direct-fleet.py')], check=True)
