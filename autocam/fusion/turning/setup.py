"""Callable Fusion setup foundation. Not part of the live Runner dispatch table."""
from .plan import build_turning_plan


def prepare_turning_setup(cam, body, spec, *, cam_api=None):
    """Create an empty turning setup for inspection; never generate or post CAM.

    The caller supplies the single imported solid. Stock/WCS, fixtures, tools,
    and operations intentionally remain manual until verified on the actual lathe.
    API contract: Autodesk Setup.operationType and Turning Workflow API Sample.
    """
    plan = build_turning_plan(spec)
    if body is None or not getattr(body, 'isSolid', False):
        raise ValueError('A single solid Fusion body is required')
    if cam_api is None:
        import adsk.cam as cam_api
    setup_input = cam.setups.createInput(cam_api.OperationTypes.TurningOperation)
    setup_input.models = [body]
    setup = cam.setups.add(setup_input)
    try:
        setup.name = f"DRAFT - {plan['name']} - configure stock and WCS"
    except Exception:
        setup.deleteMe()
        raise
    return {'setup': setup, 'plan': plan, 'readyForGeneration': False}
