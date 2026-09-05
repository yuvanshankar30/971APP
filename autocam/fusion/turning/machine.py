"""The first Fusion turning target, separate from the LinuxCNC router profile."""
HAAS_TL1 = {
    'machineModel': 'Haas TL-1',
    'controller': 'haas',
    'postFamily': 'HAAS Turning',
    # Required local reviewed asset name; not bundled or approved by this draft.
    'postProcessor': 'haas_tl1_turning.cps',
    # autocam/turning.js documents the team's TL-1 with a turret ATC.
    'toolChangeMode': 'automatic',
}


def validate_machine(spec):
    for field, expected in HAAS_TL1.items():
        if spec.get(field) != expected:
            raise ValueError(f'Haas TL-1 requires {field}={expected!r}; LinuxCNC/EMC and router posts are not supported')
    return dict(HAAS_TL1)
