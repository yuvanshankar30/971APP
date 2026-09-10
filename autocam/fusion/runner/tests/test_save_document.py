import unittest
from unittest.mock import Mock

from workflows.saveDocument import save_new_document


def _fake_data_files(files):
    """Fusion's real DataFiles collection - count/item(i) only, no
    itemByName (confirmed live: that method does not exist on it, unlike
    DataFolders - see saveDocument.py's own docstring)."""
    collection = Mock(spec=["count", "item"])
    collection.count = len(files)
    collection.item.side_effect = lambda i: files[i]
    return collection


def _fake_file(name):
    existing = Mock()
    existing.name = name
    return existing


class SaveDocumentTests(unittest.TestCase):
    def test_saves_when_name_is_available(self):
        document = Mock()
        document.saveAs.return_value = True
        folder = Mock()
        folder.dataFiles = _fake_data_files([])

        save_new_document(document, folder, "DrivebaseRail")

        document.saveAs.assert_called_once_with("DrivebaseRail", folder, "", "")

    def test_refuses_collision_without_deleting_existing_document(self):
        document = Mock()
        existing = _fake_file("DrivebaseRail")
        folder = Mock()
        folder.dataFiles = _fake_data_files([existing])

        with self.assertRaisesRegex(FileExistsError, "already exists"):
            save_new_document(document, folder, "DrivebaseRail")

        document.saveAs.assert_not_called()
        existing.deleteMe.assert_not_called()

    def test_ignores_a_differently_named_file_in_the_same_folder(self):
        document = Mock()
        document.saveAs.return_value = True
        folder = Mock()
        folder.dataFiles = _fake_data_files([_fake_file("SomeOtherPart")])

        save_new_document(document, folder, "DrivebaseRail")

        document.saveAs.assert_called_once_with("DrivebaseRail", folder, "", "")

    def test_false_save_result_is_fatal(self):
        document = Mock()
        document.saveAs.return_value = False
        folder = Mock()
        folder.dataFiles = _fake_data_files([])

        with self.assertRaisesRegex(RuntimeError, "refused to save"):
            save_new_document(document, folder, "DrivebaseRail")


if __name__ == "__main__":
    unittest.main()
