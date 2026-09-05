import os
from ..config import *
import sys

sys.path.append(OVERRIDE_PATH)


def setupTempDir():
    for path in (TEMP_PATH, INITIAL_PATH, FINAL_PATH, TOOLS_PATH):
        if not os.path.exists(path):
            os.makedirs(path)
    return TEMP_PATH
