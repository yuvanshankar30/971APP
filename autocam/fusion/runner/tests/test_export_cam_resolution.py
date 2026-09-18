"""Real, confirmed live crash: NewNCProgram.export() resolved the CAM
product via app.activeProduct - whatever workspace happens to have UI
focus, not necessarily the CAM product. Every caller (camPlate.py,
camTube.py) calls save_new_document() (a Save As) immediately before its
own export() call, and a Save As commonly switches Fusion's active
workspace back to Design. cam = adsk.cam.CAM.cast(app.activeProduct)
silently resolved to None there, and the very next line
(allSetups = cam.setups) raised AttributeError: 'NoneType' object has no
attribute 'setups' on a real "main plate 1" job, after every toolpath had
already generated successfully and the document had already saved.

export() must resolve cam the same robust way camPlate.py's own
validators already do (straight from the document's products collection,
not "whatever happens to be active"), and raise a clear, actionable error
if that still comes back empty rather than a bare AttributeError.
"""

from pathlib import Path
import unittest


_SOURCE = (Path(__file__).parents[1] / "commands/NewNCProgram.py").read_text()


def _export_body():
    # export() is the last top-level function in this file - no trailing
    # "\ndef " to bound the slice on, so this runs to end of file instead.
    export_start = _SOURCE.index("def export(")
    next_def = _SOURCE.find("\ndef ", export_start + 1)
    return _SOURCE[export_start:] if next_def == -1 else _SOURCE[export_start:next_def]


class ExportCamResolutionTests(unittest.TestCase):
    def test_export_resolves_cam_from_the_documents_products_collection(self):
        self.assertIn('app.activeDocument.products.itemByProductType("CAMProductType")', _export_body())

    def test_export_raises_a_clear_error_instead_of_a_bare_attributeerror_when_cam_is_missing(self):
        export_body = _export_body()
        self.assertIn("if not cam:", export_body)
        self.assertIn("raise RuntimeError(", export_body)
        # The guard has to come before the line that crashed live.
        self.assertLess(export_body.index("if not cam:"), export_body.index("allSetups = cam.setups"))


if __name__ == "__main__":
    unittest.main()
