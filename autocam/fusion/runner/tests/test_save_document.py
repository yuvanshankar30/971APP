import unittest
from unittest.mock import Mock

from workflows.saveDocument import save_new_document


class SaveDocumentTests(unittest.TestCase):
    def test_saves_when_name_is_available(self):
        document = Mock()
        document.saveAs.return_value = True
        folder = Mock()
        folder.dataFiles.itemByName.return_value = None

        save_new_document(document, folder, "DrivebaseRail")

        document.saveAs.assert_called_once_with("DrivebaseRail", folder, "", "")

    def test_refuses_collision_without_deleting_existing_document(self):
        document = Mock()
        existing = Mock()
        folder = Mock()
        folder.dataFiles.itemByName.return_value = existing

        with self.assertRaisesRegex(FileExistsError, "already exists"):
            save_new_document(document, folder, "DrivebaseRail")

        document.saveAs.assert_not_called()
        existing.deleteMe.assert_not_called()

    def test_false_save_result_is_fatal(self):
        document = Mock()
        document.saveAs.return_value = False
        folder = Mock()
        folder.dataFiles.itemByName.return_value = None

        with self.assertRaisesRegex(RuntimeError, "refused to save"):
            save_new_document(document, folder, "DrivebaseRail")


if __name__ == "__main__":
    unittest.main()
