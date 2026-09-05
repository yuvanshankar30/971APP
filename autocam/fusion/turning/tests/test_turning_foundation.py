import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from autocam.fusion.turning.plan import build_turning_plan
from autocam.fusion.turning.setup import prepare_turning_setup

EXAMPLE = json.loads((Path(__file__).parents[1] / 'example.json').read_text())

class TurningFoundationTests(unittest.TestCase):
    def test_exposed_length_and_radius_are_explicit(self):
        plan = build_turning_plan(EXAMPLE)
        self.assertEqual(plan['exposedStockLength'], 3)
        self.assertEqual(plan['requiredExposedLength'], 2.375)
        self.assertEqual(plan['radialStockAllowance'], 0.125)
        self.assertFalse(plan['readyForGeneration'])
        self.assertNotIn('status', plan)
        self.assertNotIn('gcode', plan)

    def test_rejects_stock_and_chuck_conflicts(self):
        for name, value in [('stockDiameter', 0.5), ('stockLength', 2), ('chuckGripLength', 4), ('frontAllowance', -1)]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                build_turning_plan({**EXAMPLE, name: value})

    def test_rejects_ambiguous_numbers_and_unsupported_work(self):
        for change in [ {'partDiameter': True}, {'partLength': float('nan')}, {'stockLength': float('inf')},
                       {'partLength': '2'}, {'maxRpm': 0}, {'maxRpm': True}, {'quantity': 2}, {'quantity': True},
                       {'units': 'mm'}, {'stockShape': 'hex'}, {'spindleAxis': 'X'}, {'origin': 'automatic'},
                       {'operations': ['thread']}, {'machineId': ''}, {'toolChangeMode': 'guess'}, {'stepFileName': 'part.stl'} ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                build_turning_plan({**EXAMPLE, **change})

    def test_planning_does_not_mutate_the_input(self):
        spec = copy.deepcopy(EXAMPLE)
        plan = build_turning_plan(spec)
        plan['operations'].append('unsupported')
        self.assertEqual(spec, EXAMPLE)

    def test_setup_is_turning_with_exact_model_and_no_generation(self):
        cam = Mock()
        api = SimpleNamespace(OperationTypes=SimpleNamespace(TurningOperation='turning'))
        body = SimpleNamespace(isSolid=True)
        result = prepare_turning_setup(cam, body, EXAMPLE, cam_api=api)
        cam.setups.createInput.assert_called_once_with('turning')
        self.assertEqual(cam.setups.createInput.return_value.models, [body])
        self.assertIn('DRAFT', result['setup'].name)
        cam.generateToolpath.assert_not_called()
        cam.generateAllToolpaths.assert_not_called()
        cam.ncPrograms.add.assert_not_called()
        self.assertFalse(result['readyForGeneration'])

    def test_targets_the_team_haas_tl1_and_rejects_emc(self):
        plan = build_turning_plan(EXAMPLE)
        self.assertEqual(plan['machineModel'], 'Haas TL-1')
        self.assertEqual(plan['controller'], 'haas')
        self.assertEqual(plan['postFamily'], 'HAAS Turning')
        self.assertEqual(plan['toolChangeMode'], 'automatic')
        for change in [{'controller': 'linuxcnc'}, {'postProcessor': '971_emc.cps'},
                       {'postProcessor': 'shopsabre.cps'}, {'postFamily': 'HAAS Milling'},
                       {'machineModel': 'Haas ST-10'}, {'toolChangeMode': 'manual'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                build_turning_plan({**EXAMPLE, **change})

    def test_invalid_input_does_not_touch_fusion(self):
        cam = Mock()
        with self.assertRaises(ValueError):
            prepare_turning_setup(cam, None, EXAMPLE)
        self.assertEqual(cam.mock_calls, [])

if __name__ == '__main__':
    unittest.main()
