"""Build a reviewable turning setup plan without touching Fusion or the job queue."""
import argparse
import json
import math
from pathlib import Path

SCHEMA_VERSION = 1
OPERATIONS = ('face', 'od_rough', 'od_finish')


def _number(data, name, *, allow_zero=False):
    value = data.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be a finite number in inches')
    if value < 0 or (value == 0 and not allow_zero):
        raise ValueError(f'{name} must be {"nonnegative" if allow_zero else "positive"}')
    return float(value)


def _text(data, name):
    value = data.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{name} is required')
    return value.strip()


def build_turning_plan(spec):
    """Validate explicit stock/workholding dimensions; do not infer them from a mesh.

    All lengths are inches. Diameter fields are diameters, never profile radii.
    This is a planning contract, not an insertable cam_jobs row.
    """
    if not isinstance(spec, dict) or type(spec.get('schemaVersion')) is not int or spec.get('schemaVersion') != SCHEMA_VERSION:
        raise ValueError('Unsupported turning specification version')
    if spec.get('units') != 'in' or spec.get('stockShape') != 'round':
        raise ValueError('The prototype supports inch units and round stock only')
    if type(spec.get('quantity')) is not int or spec.get('quantity') != 1:
        raise ValueError('The prototype supports exactly one part per setup')
    if spec.get('spindleAxis') != 'Z' or spec.get('origin') != 'front_face':
        raise ValueError('Use an explicitly aligned Z spindle axis and front-face origin')
    operations = spec.get('operations')
    if operations != list(OPERATIONS):
        raise ValueError('The prototype supports face, OD rough, and OD finish in that order')
    dimensions = {name: _number(spec, name) for name in (
        'partDiameter', 'partLength', 'stockDiameter', 'stockLength', 'chuckGripLength', 'chuckClearance')}
    dimensions['frontAllowance'] = _number(spec, 'frontAllowance', allow_zero=True)
    if dimensions['stockDiameter'] < dimensions['partDiameter']:
        raise ValueError('Stock diameter is smaller than the part diameter')
    usable_length = dimensions['stockLength'] - dimensions['chuckGripLength']
    required_length = dimensions['partLength'] + dimensions['frontAllowance'] + dimensions['chuckClearance']
    if usable_length < required_length:
        raise ValueError('Stock leaves insufficient exposed length for the part, facing allowance, and chuck clearance')
    max_rpm = spec.get('maxRpm')
    if isinstance(max_rpm, bool) or not isinstance(max_rpm, int) or max_rpm <= 0:
        raise ValueError('maxRpm must be a positive integer approved for the lathe and workholding')
    refs = {key: _text(spec, key) for key in ('name', 'stepFileName', 'machineId', 'toolLibrary', 'postProcessor')}
    if Path(refs['stepFileName']).suffix.lower() not in ('.step', '.stp'):
        raise ValueError('A STEP file is required')
    if spec.get('toolChangeMode') not in ('manual', 'automatic'):
        raise ValueError('Select manual or automatic tool changes explicitly')
    return {
        'schemaVersion': SCHEMA_VERSION, 'camEngine': 'fusion', 'fusionJobKind': 'turning:cam',
        **refs, **dimensions, 'units': 'in', 'stockShape': 'round', 'quantity': 1,
        'spindleAxis': 'Z', 'origin': 'front_face', 'toolChangeMode': spec['toolChangeMode'],
        'maxRpm': max_rpm, 'operations': list(OPERATIONS),
        'exposedStockLength': usable_length, 'requiredExposedLength': required_length,
        'radialStockAllowance': (dimensions['stockDiameter'] - dimensions['partDiameter']) / 2,
        'readyForGeneration': False,
        'remainingSteps': [
            'Verify imported body orientation and measured dimensions',
            'Configure stock, chuck fixture, WCS, and turning insert/holder geometry in Fusion',
            'Apply reviewed turning operations, feeds, spindle limits, and tool-change policy',
            'Simulate and review output from the selected lathe postprocessor',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description='Validate a Fusion turning draft; never queues or generates CAM')
    parser.add_argument('spec', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(build_turning_plan(json.loads(args.spec.read_text())), indent=2, allow_nan=False))
    except (ValueError, OSError, TypeError) as error:
        parser.exit(2, f'Invalid turning draft: {error}\n')


if __name__ == '__main__':
    main()
