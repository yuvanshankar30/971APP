"""CPU-only regression tests; no weights, third-party packages, or network."""
import ast
from pathlib import Path
import unittest

from fuel_tracking import PieceTracker, goal_entry, nearest_pixel_track


class FuelTrackingTest(unittest.TestCase):
    def test_prediction_preserves_crossing_tracks(self):
        tracker = PieceTracker(max_match_distance_px=30)
        tracker.update(0, [(0, 0), (30, 0)])
        tracker.update(100, [(10, 0), (20, 0)])
        tracker.update(200, [(10, 0), (20, 0)])
        self.assertEqual(tracker.all_trajectories()[0][-1], (200, 20, 0))
        self.assertEqual(tracker.all_trajectories()[1][-1], (200, 10, 0))

    def test_closest_pair_wins_not_oldest_track(self):
        tracker = PieceTracker(max_match_distance_px=20)
        tracker.update(0, [(0, 0), (10, 0)])
        tracker.update(100, [(9, 0)])
        self.assertEqual(len(tracker.all_trajectories()[0]), 1)
        self.assertEqual(len(tracker.all_trajectories()[1]), 2)

    def test_missed_frames_prediction_and_retirement(self):
        tracker = PieceTracker(max_match_distance_px=5, max_missed_frames=1)
        tracker.update(0, [(0, 0)])
        tracker.update(100, [(4, 0)])
        tracker.update(200, [])
        tracker.update(300, [(12, 0)])
        self.assertEqual(len(tracker.all_trajectories()), 1)
        tracker.update(400, [])
        tracker.update(500, [])
        self.assertEqual(len(tracker.finished), 1)
        self.assertFalse(tracker._active)

    def test_each_detection_is_used_only_once(self):
        tracker = PieceTracker()
        tracker.update(0, [(0, 0), (1, 0)])
        tracker.update(100, [(0, 0)])
        self.assertEqual(sum(len(t) for t in tracker.all_trajectories()), 3)

    def test_pixel_attribution_does_not_compare_pixels_and_metres(self):
        shooter = {'trajectory': [{'t': 0, 'x': 2, 'y': 3, 'pixel_x': 500, 'pixel_y': 400, 'calibrated': True}]}
        wrong = {'trajectory': [{'t': 0, 'x': 500, 'y': 400, 'pixel_x': 800, 'pixel_y': 700, 'calibrated': True}]}
        self.assertIs(nearest_pixel_track((500, 400), [wrong, shooter], 0)[0], shooter)
        self.assertIsNone(nearest_pixel_track((500, 400), [{'trajectory': [{'t': 0, 'x': 500, 'y': 400, 'calibrated': True}]}], 0)[0])

    def test_attribution_distance_and_time_gates_and_legacy_pixels(self):
        robot = {'trajectory': [{'t': 0, 'x': 10, 'y': 10, 'calibrated': False}]}
        self.assertIs(nearest_pixel_track((10, 10), [robot], 0)[0], robot)
        self.assertIsNone(nearest_pixel_track((500, 400), [robot], 0)[0])
        self.assertIsNone(nearest_pixel_track((10, 10), [robot], 501)[0])

    def test_goal_entry_rejects_stationary_and_already_inside_blobs(self):
        inside = lambda p: p[0] >= 10
        self.assertIsNone(goal_entry([(0, 20, 0), (100, 20, 0)], inside))
        self.assertEqual(goal_entry([(0, 0, 0), (100, 20, 0), (200, 0, 0), (300, 20, 0)], inside), (100, 20, 0))

    def test_score_function_uses_entry_and_pixel_attribution(self):
        # Compile only this function so its real orchestration is tested without
        # importing CUDA/Ultralytics/OpenCV or loading environment credentials.
        tree = ast.parse(Path(__file__).with_name('vision_runner.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'attribute_scores')
        namespace = {'goal_entry': goal_entry, 'nearest_pixel_track': nearest_pixel_track,
                     'point_in_zone': lambda point, polygon, shape: point[0] >= 10}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<attribute_scores>', 'exec'), namespace)
        score = namespace['attribute_scores']
        robot = {'team_key': 'frc971', 'alliance': 'red', 'track_key': 'v:1',
                 'trajectory': [{'t': 0, 'x': 3, 'y': 4, 'pixel_x': 0, 'pixel_y': 0, 'calibrated': True}]}
        zones = [{'alliance': 'red', 'polygon': [], 'label': 'hub'}]
        self.assertEqual(score([[(0, 20, 0), (100, 20, 0)]], [robot], zones, (100, 100), 'v'), [])
        observations = score([[(0, 0, 0), (100, 20, 0), (200, 0, 0)]], [robot], zones, (100, 100), 'v')
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]['ended_ms'], 100)
        self.assertEqual(observations[0]['team_key'], 'frc971')
        self.assertEqual(observations[0]['review_status'], 'unreviewed')

    def test_each_video_selects_bytetrack_without_cross_camera_persistence(self):
        tree = ast.parse(Path(__file__).with_name('vision_runner.py').read_text())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == 'track']
        self.assertEqual(len(calls), 1)
        options = {keyword.arg: ast.literal_eval(keyword.value)
                   for keyword in calls[0].keywords if keyword.arg in {'tracker', 'persist'}}
        self.assertEqual(options, {'tracker': 'bytetrack.yaml', 'persist': False})


if __name__ == '__main__':
    unittest.main()
