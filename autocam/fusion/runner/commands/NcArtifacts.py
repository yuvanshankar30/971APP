"""Read Fusion-posted files as exact bytes for authenticated upload."""
import base64
import hashlib
import os


def collect_nc_artifacts(export_dir):
    artifacts = []
    if not os.path.isdir(export_dir):
        raise ValueError('Fusion did not create an NC output directory')
    for root, dirs, files in os.walk(export_dir):
        dirs.sort()
        for filename in sorted(files):
            path = os.path.join(root, filename)
            relative_name = os.path.relpath(path, export_dir).replace(os.sep, '/')
            with open(path, 'rb') as output:
                content = output.read()
            artifacts.append({
                'name': relative_name,
                'contentBase64': base64.b64encode(content).decode('ascii'),
                'size': len(content),
                'sha256': hashlib.sha256(content).hexdigest(),
            })
    if not artifacts:
        raise ValueError('Fusion postprocessor created no NC files')
    return artifacts
