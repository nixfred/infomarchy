#!/usr/bin/python3
"""Exec the fixed Serve command; kernel cleanup survives removal or parent crash."""
import ctypes
import os
import signal
import sys

def arm_parent_death(parent):
    # Set before checking: closes the parent-exited-before-prctl race.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        sys.exit(1)
    if parent <= 1 or os.getppid() != parent:
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3 or not all(arg.isdecimal() for arg in sys.argv[1:]):
        sys.exit(2)
    parent, port = map(int, sys.argv[1:])
    if not 1024 <= port <= 65535:
        sys.exit(2)
    arm_parent_death(parent)
    os.execv("/usr/bin/tailscale", ["tailscale", "serve", "--https=8788", "http://127.0.0.1:" + str(port)])
