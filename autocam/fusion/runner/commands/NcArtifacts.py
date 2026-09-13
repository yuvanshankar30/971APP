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
            # A file Fusion's post-processor touched but never wrote real
            # G-code into (e.g. an operation with zero valid moves, or an
            # export that failed partway) is a silent failure, not a
            # completed job - fail loudly here, naming the specific file,
            # rather than uploading an empty artifact that only surfaces
            # later as a vague "no G-code" error once someone tries to
            # install/open it.
            if len(content) == 0:
                raise ValueError('Fusion postprocessor wrote an empty output file: {}'.format(relative_name))
            artifacts.append({
                'name': relative_name,
                'contentBase64': base64.b64encode(content).decode('ascii'),
                'size': len(content),
                'sha256': hashlib.sha256(content).hexdigest(),
            })
    if not artifacts:
        raise ValueError('Fusion postprocessor created no NC files')
    return artifacts
